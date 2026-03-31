/**
 * 测试用：镜像 message-pipeline 核心编排（无飞书、无幂等），便于验证 data_auditor 与指标拆解。
 */
import { routeMessage } from '../../src/services/message-router.js';
import { dispatchToAgent } from '../../src/services/agent-handlers.js';
import { planAndExecute } from '../../src/services/master-planner.js';
import { tryDeterministicReply } from '../../src/services/deterministic-replies.js';
import { detectMetricFromQuestion } from '../../src/services/analysis-intent.js';
import { detectIntent } from '../../src/services/intent-classifier.js';
import { extractTimeRangeFromText } from '../../src/services/data-executor.js';
import { analyzeMetricTree } from '../../src/services/analysis-engine.js';

function inferLlmContextFromRoute(route, text) {
  const t = String(text || '');
  if (/为什么|为何|原因|分析|趋势|异常|下降|下滑/.test(t)) {
    return {
      mode: 'single',
      intent: 'analysis',
      complexity: /为什么|原因|趋势|异常/.test(t) ? 'high' : 'medium'
    };
  }
  if (route === 'chief_evaluator' || route === 'appeal') {
    return { mode: 'single', intent: 'analysis', complexity: 'high' };
  }
  if (route === 'marketing_planner' || route === 'marketing_executor' || route === 'marketing') {
    return { mode: 'single', intent: 'analysis', complexity: 'medium' };
  }
  if (route === 'train_advisor') {
    return { mode: 'single', intent: 'query', complexity: 'medium' };
  }
  return { mode: 'single', intent: 'query', complexity: 'low' };
}

function mergePlannerLlmContext(plannerPlan, route, text) {
  if (plannerPlan && plannerPlan.intent != null) {
    return {
      intent: plannerPlan.intent,
      complexity: plannerPlan.complexity ?? 'low',
      mode: plannerPlan.mode ?? 'single'
    };
  }
  return inferLlmContextFromRoute(route, text);
}

/**
 * @param {string} text
 * @param {{ store: string, username?: string, role?: string, name?: string }} ctx
 * @param {{ skipPlanner?: boolean, forceDataAuditor?: boolean }} opts
 */
export async function runAgentAnalysisPipeline(text, ctx, opts = {}) {
  const username = ctx.username || 'test_pipeline_user';
  const pipelineIntent = detectIntent(text);
  let rt = await routeMessage(text, false, username);
  const baseCtx = { ...ctx, username, pipelineIntent };
  baseCtx.forceAnalysis = pipelineIntent === 'analysis';
  baseCtx.forceStrategy = pipelineIntent === 'strategy';
  if (pipelineIntent === 'strategy') {
    rt = { ...rt, route: 'marketing_planner' };
  }

  if (!opts.forceDataAuditor && !opts.skipPlanner && pipelineIntent !== 'analysis' && pipelineIntent !== 'strategy') {
    try {
      const plannerRes = await planAndExecute(text, baseCtx);
      const plan = plannerRes?.plan ?? null;
      if (plannerRes?.agent === 'master_planner' && plannerRes.response) {
        return {
          source: 'master_planner',
          text: String(plannerRes.response || ''),
          plannerPlan: plan,
          raw: plannerRes
        };
      }
    } catch {
      /* fall through */
    }
  }

  if (pipelineIntent === 'analysis' && baseCtx.store) {
    try {
      const tr = extractTimeRangeFromText(text);
      const metricCode = detectMetricFromQuestion(text) || 'revenue';
      baseCtx.metricAnalysis = await analyzeMetricTree(metricCode, baseCtx.store, tr);
    } catch {
      /* optional DB */
    }
  }

  if (!opts.forceDataAuditor) {
    try {
      const det = await tryDeterministicReply(text, baseCtx);
      if (det) return { source: 'deterministic', text: String(det), raw: null };
    } catch {
      /* fall through */
    }
  }

  baseCtx.llmContext = mergePlannerLlmContext(null, rt.route, text);

  if (opts.forceDataAuditor) {
    const res = await dispatchToAgent('data_auditor', text, baseCtx);
    return { source: 'data_auditor_forced', text: String(res.response || ''), raw: res, route: 'data_auditor' };
  }

  const res = await dispatchToAgent(rt.route, text, baseCtx);
  return { source: res.agent, text: String(res.response || ''), raw: res, route: rt.route };
}
