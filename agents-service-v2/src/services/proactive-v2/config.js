/**
 * Proactive Configuration
 *
 * 控制主动检测模块的行为
 */

export default {
  // 是否启用 proactive 功能
  enabled: true,

  // 是否使用 LLM 进行决策判断
  useLLM: true,

  // 是否记录详细日志
  log: true,

  // LLM 配置
  llm: {
    // 超时时间（毫秒）- gemma4:26b 需要更长时间
    timeout: 60000,

    // Fallback 规则：营收下降阈值（百分比）
    revenueDropThreshold: 20,

    // Fallback 规则：差评激增阈值
    badReviewSpikeThreshold: 5,
  },

  // 去重规则
  dedupe: {
    // 同一门店同一异常类型在指定分钟内不重复触发
    windowMinutes: 10,
  },

  // LLM 提供商配置（可扩展支持 Ollama、HTTP 等）
  llmProvider: {
    type: 'ollama', // 'ollama' | 'http'
    endpoint: process.env.OLLAMA_BASE_URL 
      ? `${process.env.OLLAMA_BASE_URL}/api/generate`
      : process.env.OLLAMA_ENDPOINT 
        || 'http://localhost:11434/api/generate',
    model: process.env.OLLAMA_OPERATIONS_MODEL 
      || process.env.LLM_MODEL 
      || 'gemma4:26b',
  },
};
