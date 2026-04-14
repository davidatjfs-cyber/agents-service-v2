/**
 * 行动计划模板库 — 验证过的最佳实践方案
 *
 * 【需你定义】以下模板需要根据你的实际经营经验填充
 * 你每次审批/修改Agent行动计划后，系统也会自动存入模板库
 *
 * 工作流程：
 * 1. 异常触发 → 查模板库匹配 → 推送选项给店长
 * 2. 店长选模板 → 微调 → 创建任务
 * 3. 你审批后的方案自动存入模板库
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveAgentCanonicalStore, expandAgentStoreLabels } from '../../config/store-mapping.js';

/**
 * 硬编码模板（你验证过的最佳实践）
 *
 * 【需你定义】为每个异常场景补充2-3个方案，包含具体菜品、定价、话术
 */
const HARDCODED_TEMPLATES = [
  /* ===== 马己仙 ===== */
  {
    scenario: '午市客流不足',
    brand: '马己仙',
    priority: 1,
    options: [
      {
        title: '午市双人套餐引流',
        description: '推98元双人餐（白切鸡+干炒牛河+老火靓汤+米饭），毛利约62%，服务员话术:"今天双人餐很划算，有两道招牌"',
        success_metric: '午市订单≥45单/日，套餐点单率≥20%',
        assignee: 'store_manager',
        deadline: '明午市前',
      },
      {
        title: '周边办公楼拓展',
        description: '联系3栋写字楼前台推工作餐，68元单人套餐（一荤一素一汤+饭），配外卖袋',
        success_metric: '工作日午市外卖+自提订单≥15单/日',
        assignee: 'store_manager',
        deadline: '3天内完成首栋签约',
      },
    ],
  },
  {
    scenario: '客单价下降',
    brand: '马己仙',
    priority: 1,
    options: [
      {
        title: '高毛利菜品推荐',
        description: '服务员点餐时推荐烧鹅（毛利66%）和老火靓汤（毛利75%），话术:"烧鹅是今天到的新鲜货"',
        success_metric: '烧鹅日销量提升30%，客单价回升至100元以上',
        assignee: 'store_manager',
        deadline: '明天开始',
      },
    ],
  },
  {
    scenario: '差评-服务',
    brand: '马己仙',
    priority: 1,
    options: [
      {
        title: '服务流程SOP复训',
        description: '培训重点：迎宾→入座→点餐→上菜→结账全流程，模拟演练3轮',
        success_metric: '3天内服务类差评清零',
        assignee: 'store_manager',
        deadline: '今天下午营业前',
      },
    ],
  },
  {
    scenario: '差评-出品',
    brand: '马己仙',
    priority: 1,
    options: [
      {
        title: '出品标准复检',
        description: '厨师长逐菜检查出品标准，重点：白切鸡火候、烧鹅皮脆度、干炒牛河镬气',
        success_metric: '3天内出品类差评清零',
        assignee: 'store_production_manager',
        deadline: '今天开始',
      },
    ],
  },

  /* ===== 洪潮 ===== */
  {
    scenario: '午市客流不足',
    brand: '洪潮',
    priority: 1,
    options: [
      {
        title: '商务午市套餐',
        description: '推168元商务双人午餐（卤鹅拼盘+蚝烙+砂锅粥+甜品），比正餐价格低35%，吸引周边商务客',
        success_metric: '午市订单≥35单/日',
        assignee: 'store_manager',
        deadline: '明午市前',
      },
    ],
  },
  {
    scenario: '客单价下降',
    brand: '洪潮',
    priority: 1,
    options: [
      {
        title: '高价值菜品推荐',
        description: '服务员推荐牛肉火锅（258元/毛利68%）和冻蟹（158元），话术:"今天有新鲜膏蟹"',
        success_metric: '客单价回升至260元以上',
        assignee: 'store_manager',
        deadline: '明天开始',
      },
    ],
  },
  {
    scenario: '差评-服务',
    brand: '洪潮',
    priority: 1,
    options: [
      {
        title: '中高端服务标准复训',
        description: '重点：包房服务流程、酒水推荐、宴请场景话术',
        success_metric: '3天内服务类差评清零',
        assignee: 'store_manager',
        deadline: '今天下午',
      },
    ],
  },
  {
    scenario: '差评-出品',
    brand: '洪潮',
    priority: 1,
    options: [
      {
        title: '潮汕出品标准复检',
        description: '厨师长复检：卤鹅卤制时间、生腌新鲜度、砂锅粥火候',
        success_metric: '3天内出品类差评清零',
        assignee: 'store_production_manager',
        deadline: '今天开始',
      },
    ],
  },
];

/**
 * 匹配模板 — 根据异常场景和品牌查找
 */
export function matchTemplates(scenario, brandOrStore) {
  const brand = inferBrand(brandOrStore);
  const results = [];

  for (const t of HARDCODED_TEMPLATES) {
    if (t.scenario === scenario && (!t.brand || t.brand === brand)) {
      results.push(t);
    }
  }

  return results;
}

/**
 * 从DB查历史成功方案
 */
export async function matchDBTemplates(scenario, store) {
  try {
    const brand = inferBrand(store);
    const storePats = expandAgentStoreLabels(store).map(l => `%${l.replace(/%/g, '')}%`);
    const r = await query(
      `SELECT source_data->>'outcome_evaluation' AS outcome, title, detail, source_data
       FROM master_tasks
       WHERE store ILIKE ANY($1::text[])
         AND status IN ('closed', 'settled')
         AND (source_data->>'outcome_evaluation') IS NOT NULL
         AND (source_data->>'outcome_evaluation') != 'null'
       ORDER BY resolved_at DESC
       LIMIT 10`,
      [storePats]
    );

    const successful = [];
    for (const row of (r.rows || [])) {
      try {
        const outcome = typeof row.source_data?.outcome_evaluation === 'object'
          ? row.source_data.outcome_evaluation
          : JSON.parse(row.outcome || '{}');
        if (outcome.score >= 2) {
          successful.push({
            title: row.title,
            score: outcome.score,
            scoreLabel: outcome.score_label,
            change: outcome.change_pct,
            metric: outcome.metric_label,
          });
        }
      } catch {}
    }
    return successful;
  } catch (e) {
    logger.warn({ err: e?.message }, 'DB template match failed');
    return [];
  }
}

/**
 * 异常key → 场景名称映射
 */
const ANOMALY_TO_SCENARIO = {
  revenue_achievement: '午市客流不足',
  revenue_achievement_monthly: '午市客流不足',
  revenue_drop: '午市客流不足',
  traffic_decline: '午市客流不足',
  labor_efficiency: '人效不足',
  gross_margin: '毛利异常',
  bad_review_service: '差评-服务',
  bad_review_product: '差评-出品',
  table_visit_product: '差评-出品',
  table_visit_ratio: '桌访不足',
  recharge_zero: '充值异常',
  food_safety: '食品安全',
  weekday_trend: '午市客流不足',
  meal_balance: '午市客流不足',
  dish_decline: '菜品衰退',
};

export function anomalyToScenario(anomalyKey) {
  return ANOMALY_TO_SCENARIO[anomalyKey] || null;
}

function inferBrand(input) {
  const s = String(input || '');
  if (/洪潮|hongchao/.test(s)) return '洪潮';
  if (/马己仙|majixian/.test(s)) return '马己仙';
  return '';
}

/**
 * 格式化模板为飞书推送文本
 */
export function formatTemplateOptions(templates, dbSuccesses) {
  if (!templates.length && !dbSuccesses.length) return null;

  const lines = ['📋 **建议方案（来自历史最佳实践）**：', ''];

  let idx = 1;
  for (const t of templates) {
    for (const opt of t.options) {
      lines.push(`${String.fromCharCode(64 + idx)}. ${opt.title}`);
      lines.push(`   ${opt.description}`);
      lines.push(`   验收: ${opt.success_metric}`);
      lines.push(`   负责: ${opt.assignee === 'store_production_manager' ? '厨师长' : '店长'} | 截止: ${opt.deadline}`);
      lines.push('');
      idx++;
    }
  }

  if (dbSuccesses.length) {
    lines.push('📈 **近期成功案例**：');
    for (const s of dbSuccesses.slice(0, 3)) {
      lines.push(`   ✓ ${s.title} — ${s.scoreLabel}(${s.score}/3)，${s.metric}${s.change > 0 ? '+' : ''}${s.change}%`);
    }
    lines.push('');
  }

  lines.push('回复字母选择方案，或描述你的想法');

  return lines.join('\n');
}
