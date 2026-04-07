/**
 * LLM 路由策略 — 优先本地，API 兜底
 *
 * 策略说明：
 * - 默认全部走本地 Ollama（gemma4:26b），最大化利用免费资源
 * - 本地故障时自动降级到 API（DeepSeek），确保系统不中断
 * - 可通过环境变量精细控制每个场景的模型选择
 *
 * 环境变量：
 * - OLLAMA_OPERATIONS_MODEL：本地模型名（默认 gemma4:26b）
 * - OLLAMA_USE_LOCAL_ONLY：true=全部本地，false=按复杂度路由（默认 true）
 * - OLLAMA_LOCAL_FALLBACK：true=本地失败走 API（默认 true）
 * - OLLAMA_HEALTH_CHECK_INTERVAL：健康检查间隔 ms（默认 30000）
 */
const LOCAL_MODEL = process.env.OLLAMA_OPERATIONS_MODEL || 'gemma4:26b';
const LOCAL_ONLY = process.env.OLLAMA_USE_LOCAL_ONLY !== 'false'; // 默认 true
const LOCAL_FALLBACK = process.env.OLLAMA_LOCAL_FALLBACK !== 'false'; // 默认 true

// Ollama 健康状态追踪
let _ollamaHealthy = true;
let _ollamaFailCount = 0;
let _ollamaLastFailTime = 0;
const OLLAMA_FAIL_THRESHOLD = 3;
const OLLAMA_COOLDOWN_MS = 60000; // 1 分钟后重试

export function markOllamaFail() {
  _ollamaFailCount++;
  _ollamaLastFailTime = Date.now();
  if (_ollamaFailCount >= OLLAMA_FAIL_THRESHOLD) {
    _ollamaHealthy = false;
    logger.error({ failCount: _ollamaFailCount }, 'Ollama 连续失败，标记为不健康，后续请求将走 API');
  }
}

export function markOllamaOk() {
  if (!_ollamaHealthy) {
    logger.info('Ollama 恢复健康，后续请求将优先走本地');
  }
  _ollamaHealthy = true;
  _ollamaFailCount = 0;
}

export function isOllamaHealthy() {
  if (_ollamaHealthy) return true;
  // 冷却期过后允许重试
  if (Date.now() - _ollamaLastFailTime > OLLAMA_COOLDOWN_MS) {
    _ollamaHealthy = true;
    _ollamaFailCount = 0;
    return true;
  }
  return false;
}

export function getOllamaHealthStatus() {
  return {
    healthy: _ollamaHealthy,
    failCount: _ollamaFailCount,
    model: LOCAL_MODEL,
    localOnly: LOCAL_ONLY,
    fallbackEnabled: LOCAL_FALLBACK
  };
}

/**
 * 选择模型
 *
 * 优先级：
 * 1. 如果 OLLAMA_USE_LOCAL_ONLY=true 且 Ollama 健康 → 本地
 * 2. 如果 Ollama 不健康 → API（DeepSeek）
 * 3. 如果 OLLAMA_USE_LOCAL_ONLY=false → 按复杂度路由
 */
export function selectModel({ intent, complexity, mode }) {
  const m = String(mode || 'single');

  // workflow 模式始终走 API（需要工具调用/复杂编排）
  if (m === 'workflow') return 'deepseek-chat';

  // 本地优先模式
  if (LOCAL_ONLY) {
    if (isOllamaHealthy()) return LOCAL_MODEL;
    if (LOCAL_FALLBACK) return 'deepseek-chat';
    return LOCAL_MODEL; // 即使不健康也尝试本地
  }

  // 按复杂度路由（旧策略，保留兼容）
  const c = String(complexity || 'low').toLowerCase();
  if (intent === 'query') {
    if (c === 'low') return LOCAL_MODEL;
    return isOllamaHealthy() ? LOCAL_MODEL : 'deepseek-chat';
  }
  if (intent === 'analysis') {
    return isOllamaHealthy() ? LOCAL_MODEL : 'deepseek-chat';
  }
  if (intent === 'action') {
    return isOllamaHealthy() ? LOCAL_MODEL : 'deepseek-chat';
  }
  return isOllamaHealthy() ? LOCAL_MODEL : 'deepseek-chat';
}
