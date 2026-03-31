/**
 * External Platform Data Integration Framework
 * 
 * 对接外卖平台(美团/饿了么)、大众点评、企业微信等外部数据源
 * 当前为框架层 — 提供统一接口，具体API对接需要平台授权后填充
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ─── 平台适配器注册表 ───
const ADAPTERS = {};

export function registerAdapter(name, adapter) {
  ADAPTERS[name] = adapter;
  logger.info({ platform: name }, 'Platform adapter registered');
}

/**
 * 统一数据拉取接口
 */
export async function fetchPlatformData(platform, store, params = {}) {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    return { ok: false, error: `Platform ${platform} not registered` };
  }
  try {
    const data = await adapter.fetch(store, params);
    // 存入通用缓存表
    await cachePlatformData(platform, store, data);
    return { ok: true, data };
  } catch (e) {
    logger.error({ err: e?.message, platform, store }, 'Platform fetch failed');
    return { ok: false, error: e?.message };
  }
}

/**
 * 缓存外部平台数据到DB（通用存储）
 */
async function cachePlatformData(platform, store, data) {
  try {
    await query(
      `INSERT INTO platform_data_cache (platform, store, data, fetched_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (platform, store) DO UPDATE SET data = $3, fetched_at = NOW()`,
      [platform, store, JSON.stringify(data)]
    );
  } catch (e) {
    // 表可能不存在，静默失败
    logger.warn({ err: e?.message }, 'platform cache write failed');
  }
}

/**
 * 读取缓存的平台数据
 */
export async function getCachedPlatformData(platform, store, maxAgeMinutes = 60) {
  try {
    const r = await query(
      `SELECT data, fetched_at FROM platform_data_cache
       WHERE platform = $1 AND store = $2 AND fetched_at > NOW() - INTERVAL '${maxAgeMinutes} minutes'`,
      [platform, store]
    );
    return r.rows[0]?.data || null;
  } catch (e) { return null; }
}

// ─── 美团外卖适配器(框架) ───
registerAdapter('meituan', {
  async fetch(store, params) {
    // TODO: 接入美团开放平台API
    // 需要: app_key, app_secret, 门店poi_id
    // API: https://openapi.meituan.com/
    logger.info({ store }, 'Meituan adapter: placeholder — needs API credentials');
    // 从daily_reports中提取已有的外卖数据作为临时替代
    const r = await query(
      `SELECT date, delivery_actual, delivery_orders, delivery_pre_revenue
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 7
       ORDER BY date DESC`, [`%${store}%`]
    );
    return {
      source: 'daily_reports_fallback',
      records: r.rows || [],
      note: '当前使用日报数据替代，接入美团API后将获取实时数据'
    };
  }
});

// ─── 饿了么适配器(框架) ───
registerAdapter('eleme', {
  async fetch(store, params) {
    logger.info({ store }, 'Eleme adapter: placeholder — needs API credentials');
    return { source: 'placeholder', note: '需要饿了么开放平台授权' };
  }
});

// ─── 大众点评适配器(框架) ───
registerAdapter('dianping', {
  async fetch(store, params) {
    // 从daily_reports获取已有的点评评分
    const r = await query(
      `SELECT date, dianping_rating FROM daily_reports
       WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30 AND dianping_rating > 0
       ORDER BY date DESC LIMIT 30`, [`%${store}%`]
    );
    return {
      source: 'daily_reports',
      ratings: r.rows || [],
      latestRating: r.rows?.[0]?.dianping_rating || null
    };
  }
});

// ─── 企业微信会员数据适配器 ───
registerAdapter('wechat_members', {
  async fetch(store, params) {
    const r = await query(
      `SELECT date, new_wechat_members, wechat_month_total FROM daily_reports
       WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
       ORDER BY date DESC LIMIT 30`, [`%${store}%`]
    );
    return {
      source: 'daily_reports',
      records: r.rows || [],
      totalNewLast30d: r.rows?.reduce((s, row) => s + (parseInt(row.new_wechat_members) || 0), 0) || 0
    };
  }
});

/**
 * 汇总某门店所有平台数据
 */
export async function getStoreExternalSummary(store) {
  const results = {};
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      results[name] = await adapter.fetch(store, {});
    } catch (e) {
      results[name] = { error: e?.message };
    }
  }
  return results;
}
