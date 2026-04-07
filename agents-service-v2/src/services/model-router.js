/**
 * 按意图/复杂度/模式选择 LLM
 * OLLAMA_USE_LOCAL_ONLY=true 时：全部走本地 gemma4:26b
 * 否则：按意图/复杂度路由到 API 或本地
 */
const LOCAL_MODEL = process.env.OLLAMA_OPERATIONS_MODEL || 'qwen2:7b';
const LOCAL_ONLY = process.env.OLLAMA_USE_LOCAL_ONLY === 'true';

export function selectModel({ intent, complexity, mode }) {
  if (LOCAL_ONLY) return LOCAL_MODEL;

  const m = String(mode || 'single');
  if (m === 'workflow') {
    return 'deepseek-chat';
  }
  const c = String(complexity || 'low').toLowerCase();
  if (intent === 'query') {
    if (c === 'low') return LOCAL_MODEL;
    return 'deepseek-chat';
  }
  if (intent === 'analysis') {
    return 'deepseek-chat';
  }
  if (intent === 'action') {
    return 'deepseek-chat';
  }
  return 'deepseek-chat';
}
