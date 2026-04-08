/**
 * Proactive Runner
 *
 * 主动检测模块的调度器
 * 负责定期检查异常并触发分析
 */

import config from './config.js';
import anomalyBridge from './anomaly-bridge.js';
const { handleAnomalies } = anomalyBridge;
import { runAnomalyChecks } from '../anomaly-engine.js';
import { query } from '../../utils/db.js';

async function getActiveStores() {
  const r = await query(`SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`);
  return r.rows.map(r => r.store);
}

let isRunning = false;
let intervalId = null;

/**
 * 执行一次 proactive 检查
 * @param {Object} options - 配置选项
 * @param {string} options.frequency - 'daily' | 'weekly'
 * @param {string[]} options.stores - 指定门店列表
 * @returns {Promise<Object>} 检查结果
 */
async function runOnce(options = {}) {
  if (!config.enabled) {
    console.log('[Proactive][Runner] Disabled, skipping');
    return { enabled: false };
  }

  if (isRunning) {
    console.log('[Proactive][Runner] Already running, skipping');
    return { running: true };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.log('[Proactive][Runner] Starting proactive check...');

    // 获取要检查的门店
    const stores = options.stores || await getActiveStores();

    // 运行异常检测
    const anomalies = await runAnomalyChecks(options.frequency || 'daily', stores);

    // 处理异常（通过 bridge）
    const result = await handleAnomalies(anomalies);

    const elapsed = Date.now() - startTime;
    console.log(`[Proactive][Runner] Completed in ${elapsed}ms`, result);

    return {
      success: true,
      ...result,
      elapsed,
      frequency: options.frequency || 'daily',
    };

  } catch (err) {
    console.error('[Proactive][Runner] Error:', err.message);
    return {
      success: false,
      error: err.message,
    };
  } finally {
    isRunning = false;
  }
}

/**
 * 启动定时检查
 * @param {number} intervalMinutes - 检查间隔（分钟）
 */
function startScheduler(intervalMinutes = 60) {
  if (!config.enabled) {
    console.log('[Proactive][Runner] Disabled, not starting scheduler');
    return;
  }

  if (intervalId) {
    console.log('[Proactive][Runner] Scheduler already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[Proactive][Runner] Starting scheduler (every ${intervalMinutes}min)`);

  // 立即执行一次
  runOnce().catch(err => {
    console.error('[Proactive][Runner] Initial run error:', err.message);
  });

  // 定时执行
  intervalId = setInterval(() => {
    runOnce().catch(err => {
      console.error('[Proactive][Runner] Scheduled run error:', err.message);
    });
  }, intervalMs);
}

/**
 * 停止定时检查
 */
function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Proactive][Runner] Scheduler stopped');
  }
}

/**
 * 获取运行状态
 */
function getStatus() {
  return {
    enabled: config.enabled,
    useLLM: config.useLLM,
    isRunning,
    schedulerActive: intervalId !== null,
  };
}

export default {
  runOnce,
  startScheduler,
  stopScheduler,
  getStatus,
};
