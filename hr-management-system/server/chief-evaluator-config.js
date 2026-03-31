/**
 * Chief Evaluator (OKR) - 统一评分配置
 * 负责所有评分规则、品牌模型、绩效计算
 */

// ─────────────────────────────────────────────
// 1. 统一扣分规则（从 Data Auditor 移交）
// ─────────────────────────────────────────────
export const UNIFIED_DEDUCTION_RULES = {
  '实收营收异常': { 
    role: 'store_manager', 
    highDeduct: 40, 
    mediumDeduct: 20, 
    lowDeduct: 0,
    frequency: 'monthly',  // 每月触发1次
    dimension: '成本控制',
    description: '营收达成率偏低'
  },
  '人效值异常': { 
    role: 'store_manager', 
    highDeduct: 20, 
    mediumDeduct: 10, 
    lowDeduct: 0,
    frequency: 'monthly',  // 每月触发1次
    dimension: '成本控制',
    description: '人效率不达标'
  },
  '充值异常': { 
    role: 'store_manager', 
    highDeduct: 2, 
    mediumDeduct: 1, 
    lowDeduct: 0,
    frequency: 'daily',    // 每天触发1次
    dimension: '成本控制',
    description: '无充值记录'
  },
  '桌访异常': { 
    role: 'store_production_manager', 
    highDeduct: 10, 
    mediumDeduct: 5, 
    lowDeduct: 0,
    frequency: 'weekly',   // 每周触发1次
    dimension: '质量得分',
    description: '产品投诉过多'
  },
  '桌访占比异常': { 
    role: 'store_manager', 
    highDeduct: 20, 
    mediumDeduct: 10, 
    lowDeduct: 0,
    frequency: 'monthly',  // 每月触发1次
    dimension: '质量得分',
    description: '桌访率偏低'
  },
  '总实收毛利率异常': { 
    role: 'store_production_manager', 
    highDeduct: 40, 
    mediumDeduct: 20, 
    lowDeduct: 0,
    frequency: 'monthly',  // 每月触发1次
    dimension: '成本控制',
    description: '毛利率不达标'
  },
  '产品差评异常': { 
    role: 'store_production_manager', 
    highDeduct: 10, 
    mediumDeduct: 5, 
    lowDeduct: 0,
    frequency: 'weekly',   // 每周触发1次
    dimension: '质量得分',
    description: '产品质量差评'
  },
  '服务差评异常': { 
    role: 'store_manager', 
    highDeduct: 10, 
    mediumDeduct: 5, 
    lowDeduct: 0,
    frequency: 'weekly',   // 每周触发1次
    dimension: '质量得分',
    description: '服务质量差评'
  }
};

// ─────────────────────────────────────────────
// 2. 图片审核扣分规则（从 Ops Agent 移交）
// ─────────────────────────────────────────────
export const VISUAL_AUDIT_DEDUCTION_RULES = {
  'fail': { 
    deduct: 3, 
    description: '图片审核失败',
    dimension: '响应速度',
    role: 'store_manager'
  },
  'duplicate': { 
    deduct: 7, 
    description: '重复图片（作弊）',
    dimension: '响应速度',
    role: 'store_manager'
  }
};

// ─────────────────────────────────────────────
// 3. 品牌评分模型（统一管理）
// ─────────────────────────────────────────────
export const UNIFIED_BRAND_SCORING_MODELS = {
  '洪潮': {
    targetRoles: ['store_manager', 'store_production_manager'],
    dimensions: {
      '质量得分': { 
        weight: 0.4, 
        maxDeduct: 40,
        categories: ['桌访异常', '产品差评异常', '服务差评异常', '桌访占比异常'],
        formula: '100 - (相关异常数 × 8)'
      },
      '成本控制': { 
        weight: 0.3, 
        maxDeduct: 30,
        categories: ['实收营收异常', '人效值异常', '充值异常', '总实收毛利率异常'],
        formula: '100 - (相关异常数 × 10)'
      },
      '响应速度': { 
        weight: 0.3, 
        maxDeduct: 30,
        categories: ['图片审核失败', '重复图片'],
        formula: '100 - (审核失败 × 10 + 重复图片 × 15)'
      }
    },
    scoringPeriod: 'weekly',
    baseScore: 100
  },
  '马己仙': {
    targetRoles: ['store_manager', 'store_production_manager'],
    dimensions: {
      '出餐效率': { 
        weight: 0.4, 
        maxDeduct: 40,
        categories: ['产品差评异常', '服务差评异常'],
        formula: '100 - (差评异常数 × 10)'
      },
      '成本控制': { 
        weight: 0.4, 
        maxDeduct: 40,
        categories: ['实收营收异常', '人效值异常', '充值异常', '总实收毛利率异常'],
        formula: '100 - (相关异常数 × 10)'
      },
      '基础执行': { 
        weight: 0.2, 
        maxDeduct: 20,
        categories: ['图片审核失败', '重复图片'],
        formula: '100 - (审核失败 × 8 + 重复图片 × 15)'
      }
    },
    scoringPeriod: 'weekly',
    baseScore: 100
  }
};

// ─────────────────────────────────────────────
// 4. 绩效计算函数
// ─────────────────────────────────────────────
export function getDeductScore(category, severity, brand) {
  const base = UNIFIED_DEDUCTION_RULES[category];
  if (!base) return { deduct: 0, role: 'store_manager', dimension: '其他' };
  
  let deduct = 0;
  switch (severity) {
    case 'high':
      deduct = base.highDeduct || 5;
      break;
    case 'medium':
      deduct = base.mediumDeduct || 3;
      break;
    case 'low':
      deduct = base.lowDeduct || 1;
      break;
    default:
      deduct = base.mediumDeduct || 3;
  }
  
  return { 
    deduct, 
    role: base.role, 
    dimension: base.dimension,
    description: base.description 
  };
}

export function getVisualAuditDeduct(result, isDuplicate) {
  if (isDuplicate) {
    return { 
      deduct: VISUAL_AUDIT_DEDUCTION_RULES.duplicate.deduct, 
      description: VISUAL_AUDIT_DEDUCTION_RULES.duplicate.description,
      dimension: VISUAL_AUDIT_DEDUCTION_RULES.duplicate.dimension,
      role: VISUAL_AUDIT_DEDUCTION_RULES.duplicate.role
    };
  }
  if (result === 'fail') {
    return { 
      deduct: VISUAL_AUDIT_DEDUCTION_RULES.fail.deduct, 
      description: VISUAL_AUDIT_DEDUCTION_RULES.fail.description,
      dimension: VISUAL_AUDIT_DEDUCTION_RULES.fail.dimension,
      role: VISUAL_AUDIT_DEDUCTION_RULES.fail.role
    };
  }
  return { deduct: 0, description: '审核通过', dimension: '响应速度', role: 'store_manager' };
}

export function calculateDimensionScore(brand, dimension, issueCounts, auditCounts) {
  const model = UNIFIED_BRAND_SCORING_MODELS[brand];
  if (!model || !model.dimensions[dimension]) return 100;
  
  const config = model.dimensions[dimension];
  let score = model.baseScore;
  
  // 根据维度类型计算扣分
  switch (dimension) {
    case '质量得分':
      score -= (issueCounts['桌访异常'] || 0 + issueCounts['产品差评异常'] || 0 + issueCounts['服务差评异常'] || 0 + issueCounts['桌访占比异常'] || 0) * 8;
      break;
    case '成本控制':
      score -= (issueCounts['实收营收异常'] || 0 + issueCounts['人效值异常'] || 0 + issueCounts['充值异常'] || 0 + issueCounts['总实收毛利率异常'] || 0) * 10;
      break;
    case '响应速度':
      score -= (auditCounts['fail'] || 0) * 10;
      break;
    case '出餐效率':
      score -= (issueCounts['产品差评异常'] || 0 + issueCounts['服务差评异常'] || 0) * 10;
      break;
    case '基础执行':
      score -= (auditCounts['fail'] || 0) * 8 + (auditCounts['duplicate'] || 0) * 15;
      break;
  }
  
  return Math.max(0, Math.min(model.baseScore, score));
}

export function calculateBrandScore(brand, issueCounts, auditCounts) {
  const model = UNIFIED_BRAND_SCORING_MODELS[brand];
  if (!model) return { totalScore: 100, breakdown: {} };
  
  const breakdown = {};
  let totalScore = 0;
  
  for (const [dimension, config] of Object.entries(model.dimensions)) {
    const dimensionScore = calculateDimensionScore(brand, dimension, issueCounts, auditCounts);
    breakdown[dimension] = dimensionScore;
    totalScore += dimensionScore * config.weight;
  }
  
  return {
    totalScore: Math.round(totalScore),
    breakdown,
    model: model
  };
}

// ─────────────────────────────────────────────
// 5. 配置验证函数
// ─────────────────────────────────────────────
export function validateScoringConfig() {
  const errors = [];
  
  // 检查权重总和
  for (const [brand, model] of Object.entries(UNIFIED_BRAND_SCORING_MODELS)) {
    const totalWeight = Object.values(model.dimensions).reduce((sum, dim) => sum + dim.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      errors.push(`品牌 ${brand} 权重总和不为1.0: ${totalWeight}`);
    }
  }
  
  // 检查扣分规则完整性
  for (const [category, rule] of Object.entries(UNIFIED_DEDUCTION_RULES)) {
    if (!rule.role || !rule.dimension) {
      errors.push(`扣分规则 ${category} 缺少 role 或 dimension`);
    }
  }
  
  return errors;
}
