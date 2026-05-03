import { callLLM } from './llm-provider.js';
import { getCapabilities, pickLeastLoadedAgent, isAgentAtCapacity } from './agent-workloads.js';
import { logger } from '../utils/logger.js';

const CAPABILITIES = [
  { agent: 'ops_supervisor', categories: ['hygiene', 'service', 'daily_ops', 'general', 'action_plan', 'scheduled_inspection', 'random_inspection'] },
  { agent: 'food_quality', categories: ['food_quality'] },
  { agent: 'train_advisor', categories: ['training'] },
  { agent: 'marketing_planner', categories: ['marketing'] },
  { agent: 'marketing_executor', categories: ['marketing_action'] },
  { agent: 'data_auditor', categories: ['data_audit'] }
];

export function dispatchTask(parsedTask = {}) {
  const category = parsedTask.category || 'general';
  const matched = CAPABILITIES.find((item) => item.categories.includes(category)) || CAPABILITIES[0];
  const candidates = CAPABILITIES.filter((c) => c.categories.includes(category)).map((c) => c.agent);
  if (candidates.length > 1) {
    pickLeastLoadedAgent(candidates).then((best) => {
      if (best && best !== matched.agent) {
        logger.info({ suggested: best, ruleBased: matched.agent, category }, 'Load-assisted dispatch override available');
      }
    }).catch(() => {});
  }
  return {
    assigneeAgent: matched.agent,
    confidence: category === 'general' ? 0.7 : 0.95,
    reason: `任务类型 ${category} 匹配 ${matched.agent} 能力范围`,
    method: 'rules_first_master_dispatcher'
  };
}

export async function dispatchTaskAsync(parsedTask = {}) {
  const category = parsedTask.category || 'general';
  const capabilities = await getCapabilities();
  const matched = capabilities.find((item) => item.categories.includes(category)) || capabilities[0];
  const candidates = capabilities.filter((c) => c.categories.includes(category)).map((c) => c.agent);
  let finalAgent = matched.agent;
  if (candidates.length > 1) {
    const best = await pickLeastLoadedAgent(candidates);
    if (best) finalAgent = best;
  }
  if (await isAgentAtCapacity(finalAgent)) {
    for (const c of candidates) {
      if (c !== finalAgent && !(await isAgentAtCapacity(c))) {
        finalAgent = c;
        break;
      }
    }
  }
  return {
    assigneeAgent: finalAgent,
    confidence: category === 'general' ? 0.7 : 0.95,
    reason: `任务类型 ${category} 匹配 ${finalAgent} 能力范围（负载均衡）`,
    method: 'rules_first_with_load_balancing'
  };
}

export async function dispatchTaskWithLLMSuggestion(parsedTask = {}) {
  const ruleResult = dispatchTask(parsedTask);
  try {
    const capabilities = await getCapabilities();
    const prompt = `你是任务分配顾问。根据以下任务信息，推荐最合适的执行Agent。只能从候选列表中选择。
任务: ${parsedTask.title || parsedTask.detail || '未知'}
类别: ${parsedTask.category || 'general'}
门店: ${parsedTask.store || '未知'}
紧急度: ${parsedTask.priority || parsedTask.severity || 'medium'}

候选Agent: ${capabilities.map((c) => `${c.agent}(${c.categories.join('/')})`).join(', ')}

只返回JSON: {"agent":"xxx","reason":"xxx"}`;
    const llmResp = await callLLM(prompt, { max_tokens: 100, temperature: 0.1 });
    const parsed = JSON.parse((llmResp?.content || llmResp || '').replace(/```json\n?|```/g, '').trim());
    if (parsed?.agent && capabilities.some((c) => c.agent === parsed.agent)) {
      logger.info({ ruleAgent: ruleResult.assigneeAgent, llmAgent: parsed.agent, isDifferent: parsed.agent !== ruleResult.assigneeAgent }, 'LLM dispatch suggestion');
      return { ...ruleResult, llmSuggestion: { agent: parsed.agent, reason: parsed.reason }, finalAgent: ruleResult.assigneeAgent };
    }
  } catch (e) {
    logger.debug({ err: e?.message }, 'LLM dispatch suggestion failed, using rules');
  }
  return { ...ruleResult, finalAgent: ruleResult.assigneeAgent };
}

export { CAPABILITIES };