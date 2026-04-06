/**
 * 按意图/复杂度/模式选择 LLM（与 master-planner / message-pipeline 对齐）
 * - workflow / analysis / action：一律 DeepSeek API
 * - 仅「简单问答」intent=query 且 complexity=low：本地 Ollama（qwen2:7b）
 * - query 但 medium/high（如培训顾问、隐含多步）：仍走 DeepSeek，避免本地模型能力不足
 */
export function selectModel({ intent, complexity, mode }) {
  const m = String(mode || 'single');
  if (m === 'workflow') {
    return 'deepseek-chat';
  }
  const c = String(complexity || 'low').toLowerCase();
  if (intent === 'query') {
    if (c === 'low') return 'qwen2:7b';
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
