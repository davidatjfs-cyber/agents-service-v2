/**
 * Proactive Configuration — 环境变量默认值 + chairman_config DB 覆盖
 */

import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

function envBool(name, defaultTrue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultTrue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

const ENV_DEFAULTS = {
  /** PROACTIVE_ENABLED=false 时关闭调度与 runOnce 内逻辑 */
  enabled: envBool('PROACTIVE_ENABLED', true),

  /** PROACTIVE_USE_LLM=false 时 bridge 内跳过 LLM，直接按规则触发 */
  useLLM: envBool('PROACTIVE_USE_LLM', true),

  /**
   * Bridge 全跳过（不派 agent）：仅 PROACTIVE_MOCK_BRIDGE 或 NODE_ENV=test。
   * 与 PROACTIVE_TEST_MODE（LLM 决策桩 / anomaly-engine 桩）分离。
   */
  mockBridge: process.env.PROACTIVE_MOCK_BRIDGE === 'true' || process.env.NODE_ENV === 'test',

  /** LLM 决策桩：不调用 DeepSeek/Ollama，直接返回固定决策 */
  testMode: process.env.PROACTIVE_TEST_MODE === 'true',

  /** Proactive 决策首选模型提供方：qwen | deepseek | ollama（仅影响第一跳，仍保留自动降级链） */
  proactiveLLMProvider: String(process.env.PROACTIVE_LLM_PROVIDER || 'qwen')
    .trim()
    .toLowerCase(),

  /** 详细 console 日志 */
  log: envBool('PROACTIVE_LOG', true),

  /** 定时周期（毫秒），默认 5 分钟 */
  intervalMs: Math.max(60000, Number(process.env.PROACTIVE_INTERVAL_MS || 300000)),

  /** 启动后是否立即跑一轮 */
  immediateFirstRun: envBool('PROACTIVE_IMMEDIATE_FIRST', true),

  llm: {
    /** Proactive 决策单次调用超时（DeepSeek / Ollama 各段）；慢模型可调大 */
    timeout: Math.max(500, Number(process.env.PROACTIVE_LLM_TIMEOUT_MS || 4000)),
    revenueDropThreshold: 20,
    badReviewSpikeThreshold: 5
  },

  dedupe: {
    windowMinutes: Math.max(1, Number(process.env.PROACTIVE_DEDUPE_WINDOW_MIN || 10))
  },

  llmProvider: {
    type: 'ollama',
    endpoint: process.env.OLLAMA_BASE_URL
      ? `${String(process.env.OLLAMA_BASE_URL).replace(/\/$/, '')}/api/generate`
      : process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/api/generate',
    model:
      process.env.OLLAMA_OPERATIONS_MODEL || process.env.LLM_MODEL || 'gemma4:26b'
  }
};

let cachedConfig = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

function normalizeDbConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    useLLM: src.useLLM !== false,
    mockBridge: src.mockBridge === true,
    testMode: src.testMode === true,
    proactiveLLMProvider: String(src.proactiveLLMProvider || ENV_DEFAULTS.proactiveLLMProvider).trim().toLowerCase(),
    log: src.log !== false,
    intervalMs: Math.max(60000, Number(src.intervalMs || ENV_DEFAULTS.intervalMs || 300000)),
    immediateFirstRun: src.immediateFirstRun !== false,
    llm: {
      timeout: Math.max(500, Number(src.llmTimeoutMs || src?.llm?.timeout || ENV_DEFAULTS.llm.timeout || 4000)),
      revenueDropThreshold: Number(src.revenueDropThreshold ?? src?.llm?.revenueDropThreshold ?? ENV_DEFAULTS.llm.revenueDropThreshold ?? 20),
      badReviewSpikeThreshold: Number(src.badReviewSpikeThreshold ?? src?.llm?.badReviewSpikeThreshold ?? ENV_DEFAULTS.llm.badReviewSpikeThreshold ?? 5)
    },
    dedupe: {
      windowMinutes: Math.max(1, Number(src.dedupeWindowMinutes || src?.dedupe?.windowMinutes || ENV_DEFAULTS.dedupe.windowMinutes || 10))
    },
    notifyRoles: Array.isArray(src.notifyRoles) ? src.notifyRoles.map((x) => String(x || '').trim()).filter(Boolean) : ['admin', 'hq_manager'],
    dispatchDefaults: {
      assignee: src?.dispatchDefaults?.assignee !== false,
      management: src?.dispatchDefaults?.management !== false
    }
  };
}

function buildMergedConfig(dbCfg) {
  return {
    ...ENV_DEFAULTS,
    ...dbCfg,
    llm: { ...ENV_DEFAULTS.llm, ...(dbCfg.llm || {}) },
    dedupe: { ...ENV_DEFAULTS.dedupe, ...(dbCfg.dedupe || {}) },
    llmProvider: { ...ENV_DEFAULTS.llmProvider },
    notifyRoles: Array.isArray(dbCfg.notifyRoles) ? dbCfg.notifyRoles : ['admin', 'hq_manager'],
    dispatchDefaults: { assignee: true, management: true, ...(dbCfg.dispatchDefaults || {}) }
  };
}

export async function getProactiveConfig(forceRefresh = false) {
  if (!forceRefresh && cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) return cachedConfig;
  try {
    const r = await query(`SELECT data FROM hrms_state WHERE key = 'chairman_config' LIMIT 1`);
    const cfg = r.rows?.[0]?.data;
    const raw = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
    const dbCfg = normalizeDbConfig(raw?.proactive_rules || {});
    cachedConfig = buildMergedConfig(dbCfg);
    cachedAt = Date.now();
    return cachedConfig;
  } catch (e) {
    logger.warn({ err: e?.message }, 'proactive config: load chairman_config failed, using env defaults');
    cachedConfig = buildMergedConfig(normalizeDbConfig({}));
    cachedAt = Date.now();
    return cachedConfig;
  }
}

export function invalidateProactiveConfigCache() {
  cachedConfig = null;
  cachedAt = 0;
}

export default ENV_DEFAULTS;
