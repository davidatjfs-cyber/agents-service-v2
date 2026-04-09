/**
 * Proactive Runner — 定时 anomaly → LLM → trigger → agent
 * 顶部不静态 import anomaly-engine / anomaly-bridge，避免与 anomaly-engine 动态 import bridge 形成环。
 */

import config from './config.js';
import { query } from '../../utils/db.js';

let intervalId = null;
let isRunning = false;

async function getActiveStores() {
  const r = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  return (r.rows || []).map((row) => row.store).filter(Boolean);
}

async function proactiveTick(options = {}) {
  console.log('[Proactive] tick');

  try {
    const engine = await import('../anomaly-engine.js');
    const runAnomalyChecks = engine.runAnomalyChecks;
    const bridgeMod = await import('./anomaly-bridge.js');
    const handleAnomalies = bridgeMod.default?.handleAnomalies ?? bridgeMod.handleAnomalies;

    const stores = options.stores || (await getActiveStores());
    const frequency = options.frequency || 'daily';

    const anomalies = await runAnomalyChecks(frequency, stores, { skipProactiveBridge: true });

    const triggered = (anomalies || []).filter(
      (a) => a.triggered && !a.error && !a.skipped
    );

    console.log('[Proactive] anomalies:', triggered.length);

    if (triggered.length > 0) {
      console.log('[Proactive] calling handleAnomalies (LLM / trigger pipeline)...');
      const result = await handleAnomalies(triggered);
      console.log('[Proactive] handleAnomalies done', result);
      return result;
    }
  } catch (err) {
    console.error('[Proactive] error', err?.message || err);
    throw err;
  }
  return { processed: 0, triggered: 0 };
}

/**
 * 手动单轮（可指定门店 / 频率）；与定时 tick 同源逻辑
 */
export async function runOnce(options = {}) {
  if (!config.enabled) {
    console.log('[Proactive] disabled — runOnce skip');
    return { enabled: false };
  }

  if (isRunning) {
    console.log('[Proactive] already running, skip');
    return { running: true };
  }

  isRunning = true;
  const t0 = Date.now();

  try {
    console.log('[Proactive] runOnce start');
    const result = await proactiveTick(options);
    return { success: true, ...result, elapsed: Date.now() - t0 };
  } catch (err) {
    console.error('[Proactive] error', err?.message || err);
    return { success: false, error: err?.message || String(err) };
  } finally {
    isRunning = false;
  }
}

export function stopProactive() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Proactive] scheduler stopped');
  }
}

/**
 * 服务启动后调用：默认定时 5 分钟（PROACTIVE_INTERVAL_MS）
 */
export function startProactive() {
  if (!config.enabled) {
    console.log('[Proactive] disabled');
    return;
  }

  if (intervalId) {
    console.log('[Proactive] scheduler already active');
    return;
  }

  console.log('[Proactive] starting... intervalMs=', config.intervalMs);

  if (config.immediateFirstRun) {
    proactiveTick({}).catch((e) => console.error('[Proactive] initial tick error', e?.message));
  }

  intervalId = setInterval(() => {
    proactiveTick({}).catch((e) => console.error('[Proactive] error', e?.message));
  }, config.intervalMs);
}

/**
 * @deprecated 使用 startProactive；按「分钟」指定间隔（会停掉已有 scheduler 再起）
 */
function startScheduler(intervalMinutes = 5) {
  stopProactive();
  if (!config.enabled) {
    console.log('[Proactive] disabled, not starting scheduler');
    return;
  }
  const ms = Math.max(60000, intervalMinutes * 60 * 1000);
  console.log(`[Proactive] startScheduler (compat) every ${intervalMinutes} min`);
  if (config.immediateFirstRun) {
    proactiveTick({}).catch((e) => console.error('[Proactive] initial tick error', e?.message));
  }
  intervalId = setInterval(() => {
    proactiveTick({}).catch((e) => console.error('[Proactive] error', e?.message));
  }, ms);
}

function getStatus() {
  return {
    enabled: config.enabled,
    useLLM: config.useLLM,
    mockBridge: config.mockBridge,
    testMode: config.testMode,
    proactiveLLMProvider: config.proactiveLLMProvider,
    isRunning,
    schedulerActive: intervalId !== null,
    intervalMs: config.intervalMs
  };
}

export default {
  runOnce,
  startProactive,
  startScheduler,
  stopProactive,
  stopScheduler: stopProactive,
  getStatus
};
