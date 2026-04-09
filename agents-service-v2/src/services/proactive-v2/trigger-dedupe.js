/**
 * Trigger Deduplication (FIXED)
 *
 * 判断异常是否需要触发，避免重复
 * 
 * 修复内容：
 * 1. 增加完整错误日志
 * 2. 查询失败时返回 true（允许触发）
 * 3. 增加 fallback 机制（内存 Map 去重）
 * 4. 增加 debug 日志
 * 5. 确保异常不会阻断 proactive 执行
 */

import { query } from '../../utils/db.js';
import config from './config.js';

// =========================
// 内存 fallback 去重机制
// =========================

const DEDUPE_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟缓存

function getCacheKey(store, type) {
  return `${store}::${type}`;
}

function isCached(store, type) {
  const key = getCacheKey(store, type);
  const cached = DEDUPE_CACHE.get(key);
  
  if (!cached) {
    return { cached: false };
  }
  
  const elapsed = Date.now() - cached.timestamp;
  const isExpired = elapsed > CACHE_TTL_MS;
  
  if (isExpired) {
    DEDUPE_CACHE.delete(key);
    return { cached: false, expired: true };
  }
  
  return { cached: true };
}

function setCached(store, type) {
  DEDUPE_CACHE.set(getCacheKey(store, type), {
    timestamp: Date.now(),
    store,
    type,
  });
  
  if (config.log) {
    console.log(`[Proactive][Dedupe] Cached: ${store}/${type}`);
  }
}

function clearCache() {
  const sizeBefore = DEDUPE_CACHE.size;
  DEDUPE_CACHE.clear();
  if (config.log && sizeBefore > 0) {
    console.log(`[Proactive][Dedupe] Cache cleared (was ${sizeBefore} items)`);
  }
}

// =========================
// 辅助函数：清理过期缓存
// =========================

let cacheCleanupTimer = null;

function startCacheCleanup() {
  // 每分钟清理一次过期缓存
  if (cacheCleanupTimer) {
    clearInterval(cacheCleanupTimer);
  }
  
  cacheCleanupTimer = setInterval(() => {
    let cleared = 0;
    const now = Date.now();
    
    for (const [key, value] of DEDUPE_CACHE.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        DEDUPE_CACHE.delete(key);
        cleared++;
      }
    }
    
    if (config.log && cleared > 0) {
      console.log(`[Proactive][Dedupe] Cleanup: cleared ${cleared} expired items`);
    }
  }, 60 * 1000); // 每分钟
}

// 启动缓存清理
startCacheCleanup();

/**
 * 判断异常是否应该触发
 * @param {Object} anomaly - 异常对象
 * @param {string} anomaly.store - 门店名称
 * @param {string} anomaly.type - 异常类型
 * @returns {Promise<boolean>} 是否应该触发
 */
async function shouldTrigger(anomaly) {
  const startTime = Date.now();
  const { store, type } = anomaly;

  if (config.log) {
    console.log(`[Proactive][Dedupe Check] ${store}/${type}`);
  }

  // 基本参数检查
  if (!store || !type) {
    if (config.log) {
      console.log('[Proactive][Dedupe] Missing store or type, skipping');
      }
    return false;
  }

  try {
    // 1. 优先检查内存缓存（fast path）
    const cacheCheck = isCached(store, type);
    if (cacheCheck.cached && !cacheCheck.expired) {
      const elapsed = Date.now() - cacheCheck.timestamp;
      if (config.log) {
        console.log(`[Proactive][Dedupe] Cached skip: ${store}/${type} (${elapsed}ms ago, TTL ${CACHE_TTL_MS}ms)`);
      }
      return false;
    }

    if (config.log && cacheCheck.expired) {
      console.log(`[Proactive][Dedupe] Cache expired: ${store}/${type}`);
    }

    // 2. 数据库查询（slow path）
    const windowMinutes = config.dedupe.windowMinutes;
    
    const sql = `
      SELECT COUNT(*) as count
      FROM anomaly_triggers
      WHERE store = $1
        AND anomaly_key = $2
        AND created_at >= NOW() - INTERVAL '${windowMinutes} minutes'
    `;
    
    const result = await query(sql, [store, type]);
    const count = parseInt(result.rows[0]?.count || '0', 10);

    if (count > 0) {
      if (config.log) {
        console.log(`[Proactive][Dedupe] DB skip: ${store}/${type} (${count} in ${windowMinutes}min)`);
      }
      return false;
    }

    // 3. 允许触发，写入缓存
    setCached(store, type);
    
    const elapsed = Date.now() - startTime;
    if (config.log) {
      console.log(`[Proactive][Dedupe] Allow trigger: ${store}/${type} (DB check took ${elapsed}ms)`);
    }
    return true;
    
  } catch (err) {
    // ⚠️ 关键修复：查询失败时返回 true（允许触发），而不是 false（跳过）
    console.error('[Proactive][Dedupe] ERROR]', {
      message: err.message,
      stack: err.stack,
      anomaly: { store, type },
    });
    
    // 写入缓存以防万一
    setCached(store, type);
    
    return true; // ⚠️ 允许触发，不阻断 proactive
  }
}

/**
 * 记录已触发的异常（用于去重追踪）- FIXED
 * @param {Object} anomaly - 异常对象
 * @returns {Promise<void>}
 */
async function recordTrigger(anomaly) {
  const startTime = Date.now();
  
  try {
    const { store, type, severity, value } = anomaly;
    
    if (config.log) {
      console.log(`[Proactive][Dedupe] Record] ${store}/${type}`);
      console.log(`[Proactive][Dedupe] Check]`, {
        store,
        type,
        severity: severity || 'medium',
        value: value ? Object.keys(value).length : 0,
      });
    }
    
    const sql = `
      INSERT INTO anomaly_triggers (
        anomaly_key, store, severity, trigger_value,
        trigger_date, created_at
      ) VALUES ($1, $2, $3, $4, CURRENT_DATE, NOW())
      ON CONFLICT DO NOTHING
    `;
    
    await query(sql, [
      type,
      store,
      severity || 'medium',
      JSON.stringify(value || {})
    ]);
    
    const elapsed = Date.now() - startTime;
    if (config.log) {
      console.log(`[Proactive][Dedupe] Record OK] ${store}/${type} (${elapsed}ms)`);
    }
    
    // 同时更新内存缓存（双重保险）
    setCached(store, type);
    
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('[Proactive][Dedupe] Record ERROR]', {
      message: err.message,
      stack: err.stack,
      anomaly: { store, type },
      elapsed: `${elapsed}ms`,
    });
    
    // 记录失败不影响主流程，但更新缓存以防重复触发
    try {
      setCached(store, type);
    } catch (cacheErr) {
      console.error('[Proactive][Dedupe] Cache write failed after DB error:', cacheErr.message);
    }
  }
}

export default {
  shouldTrigger,
  recordTrigger,
};
