/**
 * 新评分模型 — 门店评级与员工评分
 *
 * 月度口径（与 agents-service `monthly-comprehensive-rating` 对齐）：
 * - 绩效分 total_score：`agent_scores` / `anomaly_rollups_v2` 当月各自然周 `total_score` 算术平均（BI 异常触发后的周汇总）。
 * - 工作态度：`master_tasks` 且 `hr_performance_recorded = true` 的备案未完成（distinct task_id）。
 * - 工作执行力：除洪潮店长（企微新增 = HRMS 营业日报当月汇总）外，均只读 `agent_messages`（开档/收档/原料/例会均由飞书轮询写入该表，口径统一）。出品经理月度按「自然日是否档口齐+原料齐」计未达标天数，与 agents 月评一致。
 * - 工作能力：出品 = `monthly_margins` 实收毛利率 vs 目标；店长 = 营业日报 **每月 9 日** `dianping_rating`（与 agents 店长能力一致）。
 */

import { pool } from './utils/database.js';
import { inferBrandFromStoreName } from './agents.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';
import {
  countFullyCompliantPMDaysInRange,
  getMajixianMeetingExecutionStatsFromAgentMessages
} from './lib/pm-execution-for-scoring.js';
import {
  dailyReportIlikePatterns,
  feishuStoreSearchPatterns,
  resolveAgentCanonicalStore,
  toFeishuStoreName
} from './v2-store-alignment.js';

/** 评分用门店匹配：合并日报口径 + 飞书/目标表常见简称（洪潮目标行常为「洪潮久光」等，仅 daily 模式会漏） */
function scoringStoreMatchPatterns(storeLabel) {
  const s = String(storeLabel || '').trim();
  if (!s) return ['%'];
  return [...new Set([...dailyReportIlikePatterns(s), ...feishuStoreSearchPatterns(s)])];
}

/**
 * 员工绩效里「单表 store = 精确值」类查询：同时尝试 HR 规范店名与飞书/Bitable 简称（马己仙↔大宁、洪潮↔久光）。
 * 洪潮、马己仙两店在代码层已覆盖；新店请在 v2-store-alignment.js 的 STORE_TO_FEISHU 补映射，或统一主数据店名。
 */
function scoringStoreExactKeys(storeLabel) {
  const s = String(storeLabel || '').trim();
  if (!s) return [];
  const canon = resolveAgentCanonicalStore(s);
  return [...new Set([s, canon, toFeishuStoreName(s), toFeishuStoreName(canon)].filter(Boolean))];
}

/** 数据不足以得出 A～D 时的等级（禁止用 C/D 当「假默认值」误导） */
export const EMPLOYEE_RATING_PENDING = '待定';

/**
 * 单店汇总（企微新增、点评等）专用：仅规范名 + 飞书写法。
 * `scoringStoreMatchPatterns` 中含 `%洪潮%` / `%马己仙%` 会把多店数据加进一家店 → 虚假高分。
 */
function scoringStoreAggregateIlikePatterns(storeLabel) {
  const keys = scoringStoreExactKeys(storeLabel);
  if (!keys.length) return ['%'];
  return [...new Set(keys.map((k) => `%${String(k).replace(/%/g, '')}%`))];
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
      // 马己仙5档口、洪潮6档口：每日开档+收档各须档口齐，原料≥1；月度按「未完全达标自然日数」评级
      data_sources: ['开档报告', '收档报告', '原料收货日报'],
      expected_frequency: 'daily',
      rating_thresholds: {
        'A': { max_noncompliant_days: 2 },
        'B': { max_noncompliant_days: 5 },
        'C': { max_noncompliant_days: 10 },
        'D': { default: true }
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
        // 企微会员每月新增数量（洪潮大宁久光店长执行力）
        rating_thresholds: {
          'A': { min_new_members: 400 },
          'B': { min_new_members: 349 },
          'C': { min_new_members: 300 },
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
    store_production_manager: {
      A_max_noncompliant_days: 2,
      B_max_noncompliant_days: 5,
      C_max_noncompliant_days: 10,
      A_max_missing: 6,
      B_max_missing: 13,
      C_max_missing: 20,
      D_min_missing: 21
    },
    store_manager: {
      hongchao: { A_min_new_members: 400, B_min_new_members: 349, C_min_new_members: 300, D_max_new_members: 299 },
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

/**
  * 与 agents-service「月度综合」一致：上月最新自然周 `anomaly_rollups_v2` 的 total_score。
  * BI 异常经 periodic-scoring 已体现在周行扣分与 total_score 中；此处不再用 agent_issues 加减分混算 total_score，避免双口径。
  * 只有毛利率异常不在周度中体现，需额外扣除。
 */
export async function getMonthlyAnomalyRollupAverageScore(username, period) {
  const [year, month] = String(period || '').split('-');
  if (!year || !month) return 100;
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInPeriod(period)).padStart(2, '0')}`;
  const monthKey = `${year}${String(month).padStart(2, '0')}`;
  const r = await pool().query(
    `SELECT total_score
     FROM agent_scores
     WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
       AND score_model = 'anomaly_rollups_v2'
       AND COALESCE(is_invalidated, false) = false
       AND period LIKE 'week_%'
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
  if (r.rows.length > 0) {
    return Number(r.rows[0].total_score);
  }
  return 100;
}

export async function calculateEmployeeScore(store, username, role, period) {
  try {
    const latestWeekScore = await getMonthlyAnomalyRollupAverageScore(username, period);
    const exceptionBonus = await calculateExceptionBonus(username, period);
    const exceptionDeduction = await calculateExceptionDeduction(username, period);
    const laborEffDeduction = await getLaborEfficiencyDeduction(store, period);
    const baseScore = latestWeekScore;
    const totalScore = Math.round(latestWeekScore + exceptionBonus - exceptionDeduction - laborEffDeduction.deduction);

    // 2～4：缺数据或无法判断 → 待定（禁止再用 C/D 当默认值误导）
    let executionRating = EMPLOYEE_RATING_PENDING;
    try {
      executionRating = (await calculateExecutionRating(store, username, role, period)) ?? EMPLOYEE_RATING_PENDING;
    } catch (e) {
      console.warn('[employee_score] execution rating error:', e?.message);
      executionRating = EMPLOYEE_RATING_PENDING;
    }

    let attitudeRating = EMPLOYEE_RATING_PENDING;
    try {
      attitudeRating = (await calculateAttitudeRating(username, period)) ?? EMPLOYEE_RATING_PENDING;
    } catch (e) {
      console.warn('[employee_score] attitude rating error:', e?.message);
      attitudeRating = EMPLOYEE_RATING_PENDING;
    }

    let abilityRating = EMPLOYEE_RATING_PENDING;
    try {
      abilityRating = (await calculateAbilityRating(store, username, role, period)) ?? EMPLOYEE_RATING_PENDING;
    } catch (e) {
      console.warn('[employee_score] ability rating error:', e?.message);
      abilityRating = EMPLOYEE_RATING_PENDING;
    }
    
    // 5. 保存结果
    try {
      await saveEmployeeScore(store, username, role, period, {
        base_score: baseScore,
        exception_bonus: exceptionBonus,
        exception_deduction: exceptionDeduction + laborEffDeduction.deduction,
        total_score: totalScore,
        execution_rating: executionRating,
        attitude_rating: attitudeRating,
        ability_rating: abilityRating
      });
    } catch (e) { console.warn('[employee_score] save error:', e?.message); }
    
    return {
      base_score: baseScore,
      total_score: totalScore,
      execution_rating: executionRating,
      attitude_rating: attitudeRating,
      ability_rating: abilityRating
    };
    
  } catch (error) {
    console.error('[employee_score] 计算失败:', error);
    return {
      base_score: null,
      total_score: null,
      execution_rating: EMPLOYEE_RATING_PENDING,
      attitude_rating: EMPLOYEE_RATING_PENDING,
      ability_rating: EMPLOYEE_RATING_PENDING
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
      // 出品经理：agent_messages（开档/收档/原料），按业务日
      const [year, month] = period.split('-');
      const startDate = `${year}-${month}-01`;
      const endDate = `${year}-${month}-${String(getDaysInPeriod(period)).padStart(2, '0')}`;
      const brandTag = inferBrandFromStoreName(store);
      const brandZh = brandTag === '洪潮' ? '洪潮' : '马己仙';
      const expectedDays = getDaysInPeriod(period);
      const compliantDays = await countFullyCompliantPMDaysInRange(store, brandZh, startDate, endDate);
      const nonCompliantDays = Math.max(0, expectedDays - compliantDays);
      const t = cfg?.execution?.store_production_manager || DEFAULT_EMPLOYEE_RATING_CONFIG.execution.store_production_manager;

      const maxA = Number(t.A_max_noncompliant_days ?? 2);
      const maxB = Number(t.B_max_noncompliant_days ?? 5);
      const maxC = Number(t.C_max_noncompliant_days ?? 10);
      if (nonCompliantDays <= maxA) return 'A';
      if (nonCompliantDays <= maxB) return 'B';
      if (nonCompliantDays <= maxC) return 'C';
      return 'D';
    }
    
    if (role === 'store_manager') {
      const brand = inferBrandFromStoreName(store);
      
      if (brand === '洪潮') {
        // 洪潮店长：企微会员每月新增数量
        const newMembers = await getMonthlyNewWechatMembers(store, period);
        if (newMembers <= 0 && !(await hasDailyReportsForStoreAggregate(store, period))) {
          return null;
        }
        const t = cfg?.execution?.store_manager?.hongchao || DEFAULT_EMPLOYEE_RATING_CONFIG.execution.store_manager.hongchao;
        if (newMembers >= Number(t.A_min_new_members)) return 'A';
        else if (newMembers >= Number(t.B_min_new_members)) return 'B';
        else if (newMembers >= Number(t.C_min_new_members)) return 'C';
        else return 'D';
      } else {
        const [y2, m2] = period.split('-');
        const ms = `${y2}-${m2}-01`;
        const me = `${y2}-${m2}-${String(getDaysInPeriod(period)).padStart(2, '0')}`;
        const mx = await getMajixianMeetingExecutionStatsFromAgentMessages(store, ms, me);
        const expectedDays = getDaysInPeriod(period);
        const totalMissing = Math.max(0, expectedDays - mx.totalMeetings);
        const lowScoreCount = mx.unqualifiedMeetings;
        const t = cfg?.execution?.store_manager?.majixian || DEFAULT_EMPLOYEE_RATING_CONFIG.execution.store_manager.majixian;
        if (totalMissing <= Number(t.A_max_missing) && lowScoreCount <= Number(t.A_max_low_score)) return 'A';
        else if (totalMissing <= Number(t.B_max_missing) && lowScoreCount <= Number(t.B_max_low_score)) return 'B';
        else if (totalMissing <= Number(t.C_max_missing) && lowScoreCount <= Number(t.C_max_low_score)) return 'C';
        else return 'D';
      }
    }
    
    return null;

  } catch (error) {
    console.error('[execution_rating] 计算失败:', error);
    return null;
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
    return null;
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
      const actualM = Number(marginData.actual_margin);
      const targetM = Number(marginData.target_margin);
      if (!Number.isFinite(actualM) || !Number.isFinite(targetM)) {
        return null;
      }

      const diff = actualM - targetM;
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
      
      if (!rating) return null;

      const key = brand === '洪潮' ? 'hongchao' : 'majixian';
      const rules = cfg?.ability?.store_manager?.[key] || DEFAULT_EMPLOYEE_RATING_CONFIG.ability.store_manager[key];
      if (!rules) return null;
      
      if (rating >= Number(rules.A_min_rating)) return 'A';
      else if (rating >= Number(rules.B_min_rating)) return 'B';
      else if (rating >= Number(rules.C_min_rating)) return 'C';
      else return 'D';
    }
    
    return null;

  } catch (error) {
    console.error('[ability_rating] 计算失败:', error);
    return null;
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
  const { startDate, endDate } = periodDateRange(period);
  const pats = scoringStoreAggregateIlikePatterns(store);

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
  const pats = scoringStoreAggregateIlikePatterns(store);
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
  const { startDate, endDate } = periodDateRange(period);
  const keys = scoringStoreExactKeys(store);
  if (!keys.length) return 0;

  const result = await pool().query(
    `SELECT COUNT(*)::int AS count FROM kitchen_reports
     WHERE store = ANY($1::text[])
       AND report_date >= $2::date AND report_date <= $3::date AND report_type = $4`,
    [keys, startDate, endDate, reportType]
  );

  return Number(result.rows[0]?.count || 0);
}

// 获取原料收货报告数量
async function getMaterialReceivingReportsCount(store, period) {
  const { startDate, endDate } = periodDateRange(period);
  const keys = scoringStoreExactKeys(store);
  if (!keys.length) return 0;

  const result = await pool().query(
    `SELECT COUNT(*)::int AS count FROM material_receiving_reports
     WHERE store = ANY($1::text[])
       AND report_date >= $2::date AND report_date <= $3::date`,
    [keys, startDate, endDate]
  );

  return Number(result.rows[0]?.count || 0);
}

// 获取门店例会报告
async function getStoreMeetingReports(store, period) {
  const { startDate, endDate } = periodDateRange(period);
  const keys = scoringStoreExactKeys(store);
  if (!keys.length) return [];

  const result = await pool().query(
    `SELECT submitted, meeting_score FROM store_meeting_reports
     WHERE store = ANY($1::text[])
       AND meeting_date >= $2::date AND meeting_date <= $3::date`,
    [keys, startDate, endDate]
  );

  return result.rows || [];
}

/**
 * 当月「工作态度」关联任务备案数（与 agents-service-v2 催办/审核链路一致）：
 * master_tasks 中 assignee 命中、来源含抽检/定时/BI 任务卡/数据审计/协作，且已打标 hr_performance_recorded
 *（满 3 次催办仍未闭环、或审核 3 次不通过等；催办路径不向 agent_scores 扣分，仅态度统计）。
 */
/** 当月工作态度备案次数（与 agents 统计一致；已 performance_invalidation 的 task_id 不计入） */
export async function getIncompleteTaskCount(username, period) {
  const un = String(username || '').trim();
  if (!un) return 0;
  const { startDate, endDate } = periodDateRange(period);
  const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];
  try {
    const result = await pool().query(
      `SELECT COUNT(DISTINCT task_id)::int AS c
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
      [un, sources, startDate, endDate]
    );
    return Number(result.rows[0]?.c || 0);
  } catch (e) {
    safeErrorLog('[attitude] getIncompleteTaskCount', e);
    return 0;
  }
}

/**
 * 出品经理工作能力用：读 monthly_margins 实际毛利率 + 目标。
 * 根因修复（2026-04）：
 * - 飞书/Bitable 写入的 store 常为「马己仙大宁店」，HRMS 员工表为「马己仙上海音乐广场店」，
 *   原先 `WHERE m.store = $1` 精确匹配会查不到行 → actual 空 → 能力固定 C。
 * - margin_targets 可能未维护某月行，LEFT JOIN 后 target_margin 为空 → 旧逻辑同样判缺省 → C。
 * 与 agents-service `getPMAbilityRating` 口径对齐：别名多键尝试 + 无表目标时按品牌默认（马己仙 64 / 洪潮 69）。
 */
async function getMarginData(store, period) {
  const s = String(store || '').trim();
  const canon = resolveAgentCanonicalStore(s);
  const candidates = [...new Set([s, canon, toFeishuStoreName(s), toFeishuStoreName(canon)].filter(Boolean))];

  for (const storeKey of candidates) {
    const result = await pool().query(
      `SELECT m.actual_margin, t.target_margin, m.brand
       FROM monthly_margins m
       LEFT JOIN margin_targets t ON m.store = t.store AND m.period = t.period
       WHERE m.store = $1 AND m.period = $2
       LIMIT 1`,
      [storeKey, period]
    );
    const row = result.rows?.[0];
    if (row == null || row.actual_margin == null) continue;

    let targetMargin = row.target_margin;
    if (targetMargin == null) {
      const b = String(row.brand || '');
      const inferred = inferBrandFromStoreName(canon || s);
      if (b.includes('洪潮') || inferred === '洪潮') targetMargin = 69;
      else if (b.includes('马己仙') || inferred === '马己仙') targetMargin = 64;
    }

    return {
      actual_margin: row.actual_margin,
      target_margin: targetMargin
    };
  }

  return { actual_margin: null, target_margin: null };
}

// 获取大众点评星级：固定取当月 **9 日** 营业日报「今日点评星级」（与 agents `getManagerAbilityRating` 一致）
async function getMonthlyDianpingRating(store, period) {
  const [year, month] = period.split('-');
  const targetDate = `${year}-${month}-09`;
  const pats = scoringStoreAggregateIlikePatterns(store);

  const result = await pool().query(
    `SELECT dianping_rating FROM daily_reports
     WHERE date = $1::date AND dianping_rating IS NOT NULL
       AND store ILIKE ANY($2::text[])
     LIMIT 1`,
    [targetDate, pats]
  );

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

/** 全库该月是否有厨房/收货同步数据（用于区分「未接表」与「真缺交」） */
async function hasGlobalKitchenOrMaterialInPeriod(period) {
  const { startDate, endDate } = periodDateRange(period);
  const r = await pool().query(
    `SELECT
       (SELECT COUNT(*)::int FROM kitchen_reports WHERE report_date >= $1::date AND report_date <= $2::date) AS kc,
       (SELECT COUNT(*)::int FROM material_receiving_reports WHERE report_date >= $1::date AND report_date <= $2::date) AS mc`,
    [startDate, endDate]
  );
  const row = r.rows?.[0] || {};
  return (Number(row.kc) || 0) > 0 || (Number(row.mc) || 0) > 0;
}

async function hasGlobalMeetingReportsInPeriod(period) {
  const { startDate, endDate } = periodDateRange(period);
  const r = await pool().query(
    `SELECT COUNT(*)::int AS c FROM store_meeting_reports
     WHERE meeting_date >= $1::date AND meeting_date <= $2::date`,
    [startDate, endDate]
  );
  return (Number(r.rows[0]?.c) || 0) > 0;
}

async function hasDailyReportsForStoreAggregate(store, period) {
  const { startDate, endDate } = periodDateRange(period);
  const pats = scoringStoreAggregateIlikePatterns(store);
  const r = await pool().query(
    `SELECT COUNT(*)::int AS c FROM daily_reports
     WHERE date >= $1::date AND date <= $2::date AND store ILIKE ANY($3::text[])`,
    [startDate, endDate, pats]
  );
  return (Number(r.rows[0]?.c) || 0) > 0;
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
  // 检查该用户在period期间是否有异常；使用上海时区转换，避免跨月归属错误
  const { startDate, endDate } = periodDateRange(period);
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM agent_issues 
    WHERE assignee_username = $1 AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date
  `, [username, startDate, endDate]);
  
  const exceptionCount = Number(result.rows[0]?.count || 0);
  if (exceptionCount > 0) return 0;

  // 兜底：当前业务主链路异常主要落在 anomaly_triggers -> 周度 anomaly_rollups_v2
  // 若本月周度扣分明细已有异常，不应再给“零异常+10”。
  const weekly = await pool().query(
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
  for (const row of weekly.rows || []) {
    const arr = parseJsonArrayMaybe(row.deductions);
    const hasPositive = arr.some((d) => Number(d?.points || 0) > 0);
    if (hasPositive) return 0;
  }
  return 10; // 零异常加10分
}

// 异常扣分规则：按类别+严重度+频率计算
// 只有毛利率异常不在周度anomaly_rollups中，需要额外扣分；其余已在周度扣分中体现
const DEDUCTION_RULES = {
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
  const { startDate, endDate } = periodDateRange(period);
  const pats = scoringStoreAggregateIlikePatterns(store);
  const result = await pool().query(
    `SELECT AVG(efficiency) AS avg_eff FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date AND efficiency > 0`,
    [pats, startDate, endDate]
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

// 根据频率计算一个月内最多触发次数
function getMaxTriggers(frequency, period) {
  const days = getDaysInPeriod(period);
  if (frequency === 'daily') return days;        // 每天1次
  if (frequency === 'weekly') return Math.ceil(days / 7); // 每周1次（约4-5次）
  return 1; // monthly: 每月1次
}

// 计算异常扣分
async function calculateExceptionDeduction(username, period) {
  // 按类别+严重度分组查询；使用上海时区转换，避免跨月归属错误
  const { startDate, endDate } = periodDateRange(period);
  const result = await pool().query(`
    SELECT category, severity, COUNT(*) as count FROM agent_issues 
    WHERE assignee_username = $1 AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date
    GROUP BY category, severity
  `, [username, startDate, endDate]);
  
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

// 获取企微会员每月新增数量（洪潮店长执行力评级用）
async function getMonthlyNewWechatMembers(store, period) {
  const { startDate, endDate } = periodDateRange(period);
  
  try {
    const pats = scoringStoreAggregateIlikePatterns(store);
    const result = await pool().query(
      `SELECT COALESCE(SUM(new_wechat_members), 0) AS total
       FROM daily_reports
       WHERE date >= $1::date AND date <= $2::date
         AND store ILIKE ANY($3::text[])`,
      [startDate, endDate, pats]
    );
    
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
