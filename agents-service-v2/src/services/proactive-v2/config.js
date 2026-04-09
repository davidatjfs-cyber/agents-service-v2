/**
 * Proactive Configuration — 全部可通过环境变量开关，默认与历史行为兼容
 */

function envBool(name, defaultTrue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultTrue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

export default {
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

  /** Proactive 决策首选模型提供方：deepseek | ollama（仅影响第一跳，仍保留自动降级链） */
  proactiveLLMProvider: String(process.env.PROACTIVE_LLM_PROVIDER || 'deepseek')
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
