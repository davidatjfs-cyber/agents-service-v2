/**
 * Trigger Deduplication — DB 窗口 + 内存快路径；失败时放行（不阻断 Proactive）
 */

import { query } from '../../utils/db.js';
import { getProactiveConfig } from './config.js';

const memDedupe = new Map();
const memTtlMs = async () => {
  const config = await getProactiveConfig();
  return Math.max(60000, (config.dedupe.windowMinutes || 10) * 60 * 1000);
};

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
    const config = await getProactiveConfig();
    if (!store || !type) {
      console.log('[Proactive][Dedupe] Missing store or type, skip trigger');
      return false;
    }

    if (config.log) {
      console.log(`[Proactive][Dedupe Check] ${store}/${type}`);
    }

    const mk = memKey(store, type);
    const prev = memDedupe.get(mk);
    const ttl = await memTtlMs();
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

function resolveTriggerDate(anomaly) {
  const v = anomaly.value || {};
  if (v.evaluationYmd) return v.evaluationYmd;
  if (v.evaluated_business_day) return v.evaluated_business_day;
  if (v.weekEnd) return v.weekEnd;
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  return today;
}

async function recordTrigger(anomaly) {
  try {
    await getProactiveConfig();
    const store = anomaly.store;
    const type = anomalyKey(anomaly);
    const severity = anomaly.severity || 'medium';
    const value = anomaly.value;
    const triggerDate = resolveTriggerDate(anomaly);

    if (!store || !type) return;

    memDedupe.set(memKey(store, type), Date.now());

    const existing = await query(
      `SELECT 1 FROM anomaly_triggers WHERE anomaly_key = $1 AND store = $2 AND trigger_date = $3::date LIMIT 1`,
      [type, store, triggerDate]
    );
    if (existing.rows?.length) {
      console.log(`[Proactive][Dedupe] Already exists: ${store}/${type} trigger_date=${triggerDate}, skip`);
      return;
    }

    const sql = `
      INSERT INTO anomaly_triggers (
        anomaly_key, store, severity, trigger_value,
        trigger_date, created_at
      ) VALUES ($1, $2, $3, $4, $5::date, NOW())
      ON CONFLICT (anomaly_key, store, trigger_date) DO NOTHING
    `;

    await query(sql, [type, store, severity, JSON.stringify(value || {}), triggerDate]);

    console.log(`[Proactive][Dedupe] Recorded proactive follow-up marker: ${store}/${type} trigger_date=${triggerDate}`);
  } catch (err) {
    console.error('[Proactive][Dedupe] Record error:', err?.message || err);
  }
}

export default {
  shouldTrigger,
  recordTrigger
};
