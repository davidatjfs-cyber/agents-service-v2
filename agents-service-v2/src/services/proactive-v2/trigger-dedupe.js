/**
 * Trigger Deduplication
 *
 * 判断异常是否需要触发，避免重复
 */

import { query } from '../../utils/db.js';
import config from './config.js';

/**
 * 判断异常是否应该触发
 * @param {Object} anomaly - 异常对象
 * @param {string} anomaly.store - 门店名称
 * @param {string} anomaly.type - 异常类型
 * @returns {Promise<boolean>} 是否应该触发
 */
async function shouldTrigger(anomaly) {
  try {
    const { store, type } = anomaly;

    if (!store || !type) {
      if (config.log) {
        console.log('[Proactive][Dedupe] Missing store or type, skipping');
      }
      return false;
    }

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
        console.log(`[Proactive][Dedupe] Skipped duplicate trigger: ${store}/${type} (${count} in ${windowMinutes}min)`);
      }
      return false;
    }

    if (config.log) {
      console.log(`[Proactive][Dedupe] Allow trigger: ${store}/${type}`);
    }
    return true;

  } catch (err) {
    console.error('[Proactive][Dedupe] Error:', err.message);
    // 出错时保守处理：不触发
    return false;
  }
}

/**
 * 记录已触发的异常（用于去重追踪）
 * @param {Object} anomaly - 异常对象
 * @returns {Promise<void>}
 */
async function recordTrigger(anomaly) {
  try {
    const { store, type, severity, value } = anomaly;

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

    if (config.log) {
      console.log(`[Proactive][Dedupe] Recorded trigger: ${store}/${type}`);
    }
  } catch (err) {
    console.error('[Proactive][Dedupe] Record error:', err.message);
    // 记录失败不影响主流程
  }
}

export default {
  shouldTrigger,
  recordTrigger,
};
