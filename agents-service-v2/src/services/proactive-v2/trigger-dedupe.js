/**
 * Trigger Deduplication — DB 窗口 + 内存快路径；失败时放行（不阻断 Proactive）
 */

import { query } from '../../utils/db.js';
import config from './config.js';

const memDedupe = new Map();
const memTtlMs = () => Math.max(60000, (config.dedupe.windowMinutes || 10) * 60 * 1000);

function memKey(store, type) {
  return `${store}::${type}`;
}

function anomalyKey(anomaly) {
  return anomaly.rule || anomaly.type || '';
}

async function shouldTrigger(anomaly) {
  const store = anomaly.store;
  const type = anomalyKey(anomaly);

  try {
    if (!store || !type) {
      console.log('[Proactive][Dedupe] Missing store or type, skip trigger');
      return false;
    }

    if (config.log) {
      console.log(`[Proactive][Dedupe Check] ${store}/${type}`);
    }

    const mk = memKey(store, type);
    const prev = memDedupe.get(mk);
    const ttl = memTtlMs();
    if (prev && Date.now() - prev < ttl) {
      console.log(`[Proactive][Dedupe] Memory skip: ${store}/${type}`);
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
      console.log(
        `[Proactive][Dedupe] Skipped duplicate: ${store}/${type} (${count} in ${windowMinutes}min)`
      );
      memDedupe.set(mk, Date.now());
      return false;
    }

    console.log(`[Proactive][Dedupe] Allow trigger: ${store}/${type}`);
    return true;
  } catch (err) {
    console.error('[Proactive][Dedupe Error]', err?.message || err);
    return true;
  }
}

async function recordTrigger(anomaly) {
  try {
    const store = anomaly.store;
    const type = anomalyKey(anomaly);
    const severity = anomaly.severity || 'medium';
    const value = anomaly.value;

    if (!store || !type) return;

    memDedupe.set(memKey(store, type), Date.now());

    const sql = `
      INSERT INTO anomaly_triggers (
        anomaly_key, store, severity, trigger_value,
        trigger_date, created_at
      ) VALUES ($1, $2, $3, $4, CURRENT_DATE, NOW())
      ON CONFLICT DO NOTHING
    `;

    await query(sql, [type, store, severity, JSON.stringify(value || {})]);

    console.log(`[Proactive][Dedupe] Recorded proactive follow-up marker: ${store}/${type}`);
  } catch (err) {
    console.error('[Proactive][Dedupe] Record error:', err?.message || err);
  }
}

export default {
  shouldTrigger,
  recordTrigger
};
