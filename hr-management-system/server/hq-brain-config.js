// ─────────────────────────────────────────────────────────────────
// HQ Brain Config — 总部决策大脑 vs 门店执行四肢 分层架构配置
// ─────────────────────────────────────────────────────────────────
//
// 设计原则：
//   总部角色 (admin/hq_manager/hr_manager) → HQ Brain tier (高算力模型, 全量工具)
//   门店角色 (store_manager/store_production_manager/employee) → Store Limb tier (轻量模型, 受限工具)
//
// 算力控制：
//   HQ Brain: 低频高深度 (日均 ~50 次调用, 高级模型)
//   Store Limb: 高频低消耗 (日均 ~500+ 次调用, 快速模型)
// ─────────────────────────────────────────────────────────────────

// ── 1. 模型层级定义 ──

const MODEL_TIERS = {
  // 总部决策大脑 — 深度推理与跨域分析
  hq_brain: {
    label: '总部决策大脑',
    reasoningModel: 'deepseek-chat',         // 深度推理 (策略生成/因果分析)
    analysisModel: 'deepseek-chat',         // 通用分析 (数据解读/报表)
    temperature: 0.3,                        // 较低温度保证稳定性
    maxTokens: 8192,                         // 允许长输出 (行动计划书)
    costBudgetDaily: 100,                    // 日预算上限 (元)
    rateLimit: { maxPerMinute: 5, maxPerHour: 60 }
  },

  // 门店执行四肢 — 快速响应与流程执行
  store_limb: {
    label: '门店执行端',
    reasoningModel: 'deepseek-chat',        // 快速推理 (SOP问答/任务确认)
    analysisModel: 'deepseek-chat',         // 同上
    temperature: 0.1,                        // 极低温度保证确定性
    maxTokens: 2048,                         // 短输出 (确认/通知)
    costBudgetDaily: 50,                     // 日预算上限 (元)
    rateLimit: { maxPerMinute: 30, maxPerHour: 500 }
  },

  // 合规审查 — 零容忍审查
  compliance: {
    label: '合规审查',
    reasoningModel: 'deepseek-chat',
    analysisModel: 'deepseek-chat',
    temperature: 0,                          // 零温度: 确定性审查
    maxTokens: 4096,
    costBudgetDaily: 20,
    rateLimit: { maxPerMinute: 10, maxPerHour: 100 }
  }
};

// ── 2. 角色→层级映射 ──

const ROLE_TIER_MAP = {
  admin:                      'hq_brain',
  hq_manager:                 'hq_brain',
  hr_manager:                 'hq_brain',
  store_manager:              'store_limb',
  store_production_manager:   'store_limb',
  employee:                   'store_limb',
  cashier:                    'store_limb'
};

// ── 3. 工具权限矩阵 ──
// HQ Brain 独有工具 (门店角色不可调用)

const HQ_ONLY_TOOLS = [
  'query_knowledge_graph',        // 知识图谱查询
  'generate_action_plan',         // 策略行动计划生成
  'cross_store_analysis',         // 跨门店对比分析
  'forecast_revenue',             // 营收预测
  'causal_chain_analysis',        // 因果链分析
  'benchmark_analysis',           // 行业基准对比
  'employee_performance_deep',    // 员工深度绩效分析
  'cost_optimization_suggest',    // 成本优化建议
  'supply_chain_analysis',        // 供应链分析
  'view_other_store_data'         // 查看其他门店数据权限
];

// 门店角色可用的基础工具（不能跨店，不能访问HQ独有工具）
const SHARED_TOOLS = [
  'query_sales_ranking',          // 销售排行（限本店）
  'query_revenue_summary',        // 营收概览（限本店）
  'query_complaint_product_ranking', // 投诉排行（限本店）
  'query_sop_knowledge',          // SOP知识库查询
  'submit_checklist',             // 检查表提交
  'query_my_tasks',               // 我的任务
  'query_my_score',               // 我的绩效
  'query_table_visit',            // 桌访查询（限本店）
  'query_table_visit_count'       // 桌访记录数（限本店）
];

// ── 4. 角色特定工具限制 ──
// hr_manager 只能访问 HR 相关工具
const HR_ONLY_TOOLS = [
  'query_employee_info',
  'manage_employee_records',
  'process_onboarding',
  'process_resignation',
  'view_hr_reports'
];

function getAvailableTools(role) {
  const tier = getModelTier(role);
  const normalizedRole = String(role || '').trim();
  
  // 总部人事只能访问HR工具
  if (normalizedRole === 'hr_manager') {
    return [...HR_ONLY_TOOLS, 'query_my_tasks', 'query_my_score'];
  }
  
  // HQ Brain 全权限
  if (tier === 'hq_brain') {
    return [...SHARED_TOOLS, ...HQ_ONLY_TOOLS, ...HR_ONLY_TOOLS];
  }
  
  // 门店角色只能使用SHARED_TOOLS，且数据会被过滤到本店
  return [...SHARED_TOOLS];
}

// ── 4. 算力追踪器 ──

const _costTracker = {
  daily: {},      // { 'YYYY-MM-DD': { hq_brain: { calls: N, tokens: N }, store_limb: {...} } }
  lastReset: ''
};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded() {
  const today = getTodayKey();
  if (_costTracker.lastReset !== today) {
    _costTracker.daily[today] = {};
    _costTracker.lastReset = today;
    // 保留最近7天数据
    const keys = Object.keys(_costTracker.daily).sort();
    while (keys.length > 7) {
      delete _costTracker.daily[keys.shift()];
    }
  }
}

function trackLLMCall(tier, tokenCount) {
  resetDailyIfNeeded();
  const today = getTodayKey();
  if (!_costTracker.daily[today]) _costTracker.daily[today] = {};
  if (!_costTracker.daily[today][tier]) _costTracker.daily[today][tier] = { calls: 0, tokens: 0 };
  _costTracker.daily[today][tier].calls += 1;
  _costTracker.daily[today][tier].tokens += (tokenCount || 0);
}

function getCostStats(days = 7) {
  resetDailyIfNeeded();
  const result = {};
  const keys = Object.keys(_costTracker.daily).sort().slice(-days);
  for (const day of keys) {
    result[day] = _costTracker.daily[day] || {};
  }
  return result;
}

function isTierBudgetExceeded(tier) {
  resetDailyIfNeeded();
  const today = getTodayKey();
  const stats = _costTracker.daily[today]?.[tier];
  if (!stats) return false;
  const tierConfig = MODEL_TIERS[tier];
  if (!tierConfig) return false;
  const hourStats = stats.calls; // 简化: 用调用次数估算
  return hourStats > (tierConfig.rateLimit?.maxPerHour || 9999);
}

// ── 5. 公开接口 ──

export function getModelTier(role) {
  const tier = ROLE_TIER_MAP[String(role || '').trim()] || 'store_limb';
  return tier;
}

export function getTierConfig(tier) {
  return MODEL_TIERS[tier] || MODEL_TIERS.store_limb;
}

export function getModelForRole(role, purpose = 'reasoning') {
  const tier = getModelTier(role);
  const config = getTierConfig(tier);
  return purpose === 'analysis' ? config.analysisModel : config.reasoningModel;
}

export function getTemperatureForRole(role) {
  const tier = getModelTier(role);
  return getTierConfig(tier).temperature;
}

export function getMaxTokensForRole(role) {
  const tier = getModelTier(role);
  return getTierConfig(tier).maxTokens;
}

export function isToolAllowed(role, toolName) {
  const tier = getModelTier(role);
  const normalizedRole = String(role || '').trim();
  
  // 总部人事只能访问HR工具
  if (normalizedRole === 'hr_manager') {
    return HR_ONLY_TOOLS.includes(toolName) || ['query_my_tasks', 'query_my_score'].includes(toolName);
  }
  
  // HQ Brain 全权限
  if (tier === 'hq_brain') return true;
  
  // 门店角色只能使用SHARED_TOOLS
  if (HQ_ONLY_TOOLS.includes(toolName) || HR_ONLY_TOOLS.includes(toolName)) return false;
  return true;
}

export function isHqRole(role) {
  return getModelTier(role) === 'hq_brain';
}

export { trackLLMCall, getCostStats, isTierBudgetExceeded, MODEL_TIERS, ROLE_TIER_MAP, HQ_ONLY_TOOLS, SHARED_TOOLS, getAvailableTools };
