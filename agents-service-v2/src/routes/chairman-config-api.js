/**
 * Chairman 配置管理 API — 供管理后台使用
 *
 * GET  /api/chairman/config        → 查看当前配置
 * POST /api/chairman/config       → 更新配置（合并写入DB）
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const CONFIG_KEY = 'chairman_config';

function getDefaultConfig() {
  return {
    stores: {
'马己仙上海音乐广场店': {
        brand: '马己仙',
        cuisine: '粤菜',
        positioning: '大众正餐',
        targetCustomer: '周边白领、家庭聚餐',
        avgPrice: 100,
        seats: 100,
        tables: 25,
        hasTakeout: true,
        coreStrategy: '走量，翻台率是生命线',
        bottleneck: '午市客流',
        signatureProducts: '',
        competitiveAdvantage: '',
        serviceStyle: '快速翻台型',
        privateRooms: 0,
        kitchenCapacity: '',
        lowSeasonNote: '',
        topDishes: [
          { name: '白切鸡', price: 68, margin: 0.68 },
          { name: '烧鹅', price: 88, margin: 0.66 },
          { name: '老火靓汤', price: 48, margin: 0.75 },
        ],
        problemDishes: [],
        target_daily_dineIn: { revenue: 10000, orders: 100, avgTicket: 100, turnover: 1.8 },
        target_daily_takeout: { revenue: 5000, orders: 80, avgTicket: 62 },
        cost_structure: { foodCostRate: 0.35, laborCostRate: 0.22, rentCostRate: 0.15, targetProfitRate: 0.18 },
      },
      '洪潮大宁久光店': {
        brand: '洪潮',
        cuisine: '潮汕菜',
        positioning: '中高端正餐',
        targetCustomer: '商务宴请、品质家庭聚餐',
        avgPrice: 260,
        seats: 90,
        tables: 20,
        hasTakeout: false,
        coreStrategy: '走质，客单价和包房利用率是核心',
        bottleneck: '晚市包房利用率',
        signatureProducts: '',
        competitiveAdvantage: '',
        serviceStyle: '精致服务型',
        privateRooms: 4,
        kitchenCapacity: '',
        lowSeasonNote: '',
        topDishes: [
          { name: '卤鹅拼盘', price: 168, margin: 0.69 },
          { name: '生腌膏蟹', price: 138, margin: 0.70 },
          { name: '牛肉火锅', price: 258, margin: 0.68 },
        ],
        problemDishes: [],
        target_daily_dineIn: { revenue: 23000, orders: 88, avgTicket: 260, turnover: 1.5 },
        target_daily_takeout: { revenue: 0, orders: 0, avgTicket: 0 },
        cost_structure: { foodCostRate: 0.32, laborCostRate: 0.20, rentCostRate: 0.18, targetProfitRate: 0.20 },
},
     },
    trend_rules: {
      weekday_trend_consecutive_weeks: 3,
      meal_balance_threshold_medium: 0.30,
      meal_balance_threshold_high: 0.25,
      meal_balance_window_days: 5,
      dish_decline_drop_pct: 0.20,
      dish_decline_consecutive_weeks: 2,
      storeOverrides: {},
    },
    training_map: {
      bad_review_service: { course: '服务流程SOP', content: '迎宾→入座→点餐→上菜→结账全流程', examPass: '考试≥90分', targetAudience: ['全部员工', '新员工(3个月内)'], cooldownDays: 14, minSeverity: 'medium' },
      bad_review_product: { course: '出品标准复训', content: '厨师长出品标准复检', examPass: '出品合格率≥95%', targetAudience: ['厨师长', '老员工'], cooldownDays: 14, minSeverity: 'medium' },
      gross_margin: { course: '成本控制规范', content: '食材损耗控制、采购验收标准', examPass: '考试≥85分', targetAudience: ['店长', '厨师长'], cooldownDays: 30, minSeverity: 'medium' },
      food_safety: { course: '食品安全紧急培训', content: '食品安全标准操作规程复训', examPass: '考试≥95分+现场检查通过', targetAudience: ['全部员工'], cooldownDays: 7, minSeverity: 'high' },
    },
    action_templates: [],
  };
}

export async function getChairmanConfig() {
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1`,
      [CONFIG_KEY]
    );
    if (r.rows?.[0]?.data) {
      return typeof r.rows[0].data === 'string'
        ? JSON.parse(r.rows[0].data)
        : r.rows[0].data;
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'Failed to load chairman config from DB, using defaults');
  }
  return getDefaultConfig();
}

export async function saveChairmanConfig(config) {
  const value = typeof config === 'string' ? config : JSON.stringify(config);
  try {
    await query(
      `INSERT INTO hrms_state (key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [CONFIG_KEY, value]
    );
    return { ok: true };
  } catch (e) {
    logger.error({ err: e?.message }, 'Failed to save chairman config');
    return { ok: false, error: e?.message };
  }
}

export function registerChairmanConfigRoutes(app) {
  app.get('/api/chairman/config', async (req, res) => {
    try {
      const config = await getChairmanConfig();
      res.json({ ok: true, config });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message });
    }
  });

  app.post('/api/chairman/config', async (req, res) => {
    try {
      const current = await getChairmanConfig();
      let updates = req.body || {};

      // Handle "init defaults" request
      if (updates.stores === 'init_defaults') {
        delete updates.stores;
        const defaults = getDefaultConfig();
        if (!current.stores || Object.keys(current.stores).length === 0) {
          updates.stores = defaults.stores;
        }
        if (!current.action_templates || current.action_templates.length === 0) {
          updates.action_templates = defaults.action_templates;
        }
        if (!current.training_map || Object.keys(current.training_map).length === 0) {
          updates.training_map = defaults.training_map;
        }
        if (!current.trend_rules || Object.keys(current.trend_rules).length === 0) {
          updates.trend_rules = defaults.trend_rules;
        }
      }

      const merged = deepMerge(current, updates);
      const result = await saveChairmanConfig(merged);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message });
    }
  });
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
