/**
 * 门店画像配置 — 注入Agent上下文的专业知识基座
 *
 * 配置来源优先级：
 * 1. 数据库 chairman_config（通过 /api/chairman/config 管理）
 * 2. 本文件硬编码默认值
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { resolveAgentCanonicalStore } from './store-mapping.js';

const DEFAULT_PROFILES = {
  '马己仙上海音乐广场店': {
    brand: '马己仙',
    cuisine: '粤菜',
    positioning: '大众正餐',
    targetCustomer: '周边白领、家庭聚餐',
    area: 300,
    seats: 100,
    tables: 25,
    avgPrice: 100,
    peakHours: ['11:30-13:30', '17:30-20:30'],
    target_daily: { revenue: 12000, orders: 120, avgTicket: 100, turnover: 1.8 },
    cost_structure: { foodCostRate: 0.35, laborCostRate: 0.22, rentCostRate: 0.15, targetProfitRate: 0.18 },
    coreStrategy: '走量，翻台率是生命线',
    bottleneck: '午市客流',
    topDishes: [
      { name: '白切鸡', price: 68, margin: 0.68 },
      { name: '烧鹅', price: 88, margin: 0.66 },
      { name: '老火靓汤', price: 48, margin: 0.75 },
    ],
    problemDishes: [],
  },
  '洪潮大宁久光店': {
    brand: '洪潮',
    cuisine: '潮汕菜',
    positioning: '中高端正餐',
    targetCustomer: '商务宴请、品质家庭聚餐',
    area: 300,
    seats: 90,
    tables: 20,
    avgPrice: 260,
    peakHours: ['11:30-13:30', '17:30-21:00'],
    target_daily: { revenue: 23000, orders: 88, avgTicket: 260, turnover: 1.5 },
    cost_structure: { foodCostRate: 0.32, laborCostRate: 0.20, rentCostRate: 0.18, targetProfitRate: 0.20 },
    coreStrategy: '走质，客单价和包房利用率是核心',
    bottleneck: '晚市包房利用率',
    topDishes: [
      { name: '卤鹅拼盘', price: 168, margin: 0.69 },
      { name: '生腌膏蟹', price: 138, margin: 0.70 },
      { name: '牛肉火锅', price: 258, margin: 0.68 },
    ],
    problemDishes: [],
  },
};

let _cachedProfiles = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function loadProfilesFromDB() {
  try {
    const r = await query(
      `SELECT config_value FROM hrms_state WHERE config_key = 'chairman_config'`
    );
    const dbConfig = r.rows?.[0]?.config_value;
    if (dbConfig && dbConfig.stores) {
      _cachedProfiles = { ...DEFAULT_PROFILES, ...dbConfig.stores };
      _cacheTime = Date.now();
      return _cachedProfiles;
    }
  } catch (e) {
    logger.warn({ err: e?.message }, 'Failed to load store profiles from DB, using defaults');
  }
  return DEFAULT_PROFILES;
}

async function getProfiles() {
  if (_cachedProfiles && Date.now() - _cacheTime < CACHE_TTL) return _cachedProfiles;
  return await loadProfilesFromDB();
}

export function getStoreProfile(storeInput) {
  const canon = resolveAgentCanonicalStore(storeInput);
  return (_cachedProfiles || DEFAULT_PROFILES)[canon] || DEFAULT_PROFILES[canon] || null;
}

export async function getStoreProfileAsync(storeInput) {
  const profiles = await getProfiles();
  const canon = resolveAgentCanonicalStore(storeInput);
  return profiles[canon] || null;
}

export function buildStoreProfilePromptBlock(storeInput) {
  const canon = resolveAgentCanonicalStore(storeInput);
  const p = (_cachedProfiles || DEFAULT_PROFILES)[canon] || DEFAULT_PROFILES[canon];
  if (!p) return '';

  const topDishText = p.topDishes?.map(d => `${d.name}(${d.price}元/毛利率${Math.round((d.margin || 0) * 100)}%)`).join('、') || '';
  const problemDishText = p.problemDishes?.length
    ? `⚠️ 需关注菜品: ${p.problemDishes.map(d => `${d.name}(${d.reason})`).join('、')}`
    : '';

  return `
【门店画像 - ${p.brand}${p.cuisine}】
定位: ${p.positioning} | 人均${p.avgPrice}元 | ${p.seats}餐位/${p.tables}桌
目标客群: ${p.targetCustomer}
核心策略: ${p.coreStrategy}
当前瓶颈: ${p.bottleneck}
日均目标: 营收${p.target_daily.revenue}元 ${p.target_daily.orders}单 翻台${p.target_daily.turnover}次 客单价${p.target_daily.avgTicket}元
成本结构: 食材${Math.round((p.cost_structure.foodCostRate || 0) * 100)}% 人力${Math.round((p.cost_structure.laborCostRate || 0) * 100)}% 租金${Math.round((p.cost_structure.rentCostRate || 0) * 100)}%
高毛利招牌: ${topDishText}
${problemDishText}`.trim();
}

export function getAllProfiles() {
  return _cachedProfiles || DEFAULT_PROFILES;
}

loadProfilesFromDB().catch(() => {});