/**
 * Anomaly Bridge — proactive：dedupe → LLM 决策 → dispatch agent
 */

import { getProactiveConfig } from './config.js';
import triggerDedupe from './trigger-dedupe.js';
const { shouldTrigger, recordTrigger } = triggerDedupe;
import llmDecision from './llm-decision.js';
const { decideWithLLM, fallbackDecision } = llmDecision;
import { dispatchToAgent } from '../agent-handlers.js';
import { acceptProactiveLlmActionPlan } from './proactive-llm-actions.js';

function normalizeAnomaly(raw) {
  const rule = raw.rule || raw.type;
  const type = rule;
  return { ...raw, type, rule };
}

async function handleAnomalies(anomalies) {
  const config = await getProactiveConfig();
  if (config.mockBridge) {
    console.log('[Proactive][MOCK BRIDGE] skip trigger');
    return { processed: 0, triggered: 0, skipped: 0, mockBridge: true };
  }

  if (!config.enabled) {
    console.log('[Proactive][Bridge] disabled, skipping');
    return { processed: 0, triggered: 0, skipped: 0 };
  }

  if (!Array.isArray(anomalies) || anomalies.length === 0) {
    console.log('[Proactive][Bridge] No anomalies to process');
    return { processed: 0, triggered: 0, skipped: 0 };
  }

  console.log('[Proactive][Bridge] batch size:', anomalies.length);

  const stats = {
    processed: 0,
    triggered: 0,
    skipped: 0,
    errors: 0
  };

  for (const raw of anomalies) {
    const anomaly = normalizeAnomaly(raw);

    if (!anomaly.type || !anomaly.store) {
      if (config.log) {
        console.log('[Proactive][Bridge] Missing type/store, skipping', anomaly);
      }
      stats.skipped++;
      continue;
    }

    try {
      stats.processed++;

      const should = await shouldTrigger(anomaly);
      if (!should) {
        stats.skipped++;
        continue;
      }

      let decision;
      if (config.useLLM) {
        try {
          console.log('[Proactive][Bridge] LLM decision for', anomaly.store, anomaly.type);
          decision = await decideWithLLM(anomaly);
        } catch (err) {
          console.error('[Proactive][Bridge] LLM decision error:', err?.message);
          decision = fallbackDecision(anomaly);
        }
      } else {
        decision = { triggered: true, reason: 'useLLM=false', priority: 'medium', actions: [] };
        console.log('[Proactive][Bridge] useLLM=false, default trigger');
      }

      if (decision.triggered) {
        try {
          const ctx = buildContext(anomaly, decision, config);
          console.log('[Proactive][Bridge] Executing trigger', ctx.type, ctx.store);
          await handleTrigger(ctx);
          await recordTrigger(anomaly);
          stats.triggered++;
        } catch (err) {
          console.error('[Proactive][Bridge] Handle trigger error:', err?.message);
          stats.errors++;
        }
      } else {
        stats.skipped++;
        console.log(
          `[Proactive][Bridge] Skipped by LLM: ${anomaly.store}/${anomaly.type} — ${decision.reason}`
        );
      }
    } catch (err) {
      console.error('[Proactive][Bridge] Process anomaly error:', err?.message);
      stats.errors++;
    }
  }

  console.log(
    `[Proactive][Bridge] Complete: processed=${stats.processed}, triggered=${stats.triggered}, skipped=${stats.skipped}, errors=${stats.errors}`
  );

  return stats;
}

function buildContext(anomaly, decision, config) {
  return {
    source: 'proactive',
    type: anomaly.type || anomaly.rule,
    store: anomaly.store,
    severity: anomaly.severity || decision.priority || 'medium',
    data: {
      ...anomaly,
      llmReason: decision.reason,
      llmPriority: decision.priority,
      llmActions: Array.isArray(decision.actions) ? decision.actions : [],
      proactiveConfigSnapshot: {
        notifyRoles: Array.isArray(config?.notifyRoles) ? config.notifyRoles : ['admin', 'hq_manager'],
        dispatchDefaults: config?.dispatchDefaults || { assignee: true, management: true }
      }
    }
  };
}

async function handleTrigger(ctx) {
  const { type, store } = ctx;

  console.log(`[Proactive][Trigger] ${type} @ ${store}`);

  const llmActions = ctx?.data?.llmActions;
  if (Array.isArray(llmActions) && llmActions.length > 0) {
    try {
      const acceptRes = await acceptProactiveLlmActionPlan(ctx);
      if (config.log) {
        console.log('[Proactive][accept_action_plan] auto proactive_llm', {
          created: acceptRes.count,
          taskIds: (acceptRes.createdTasks || []).map((t) => t.taskId)
        });
      }
    } catch (err) {
      console.error('[Proactive][accept_action_plan] failed', err?.message || err);
    }
  }

  if (type === 'revenue_drop' || type === 'revenue') {
    await dispatchToAgent('data_auditor', `分析营收下降 - ${store}`, ctx);
    await dispatchToAgent('ops_supervisor', `检查运营问题 - ${store}`, ctx);
    await dispatchToAgent('marketing_planner', `制定提升方案 - ${store}`, ctx);
  } else if (
    type === 'bad_review_spike' ||
    type === 'bad_review_service' ||
    type === 'bad_review_product' ||
    type === 'bad_review'
  ) {
    await dispatchToAgent('food_quality', `分析差评问题 - ${store}`, ctx);
    await dispatchToAgent('ops_supervisor', `检查服务问题 - ${store}`, ctx);
  } else if (type === 'gross_margin') {
    await dispatchToAgent('data_auditor', `分析毛利率异常 - ${store}`, ctx);
    await dispatchToAgent('procurement_advisor', `检查采购成本 - ${store}`, ctx);
  } else if (type === 'labor' || type === 'labor_efficiency' || type === 'labor_cost') {
    await dispatchToAgent('ops_supervisor', `分析人工成本 - ${store}`, ctx);
    await dispatchToAgent('data_auditor', `检查人工数据 - ${store}`, ctx);
  } else if (type === 'traffic' || type === 'customer_flow') {
    await dispatchToAgent('marketing_planner', `分析客流下降 - ${store}`, ctx);
    await dispatchToAgent('ops_supervisor', `检查运营状况 - ${store}`, ctx);
  } else {
    await dispatchToAgent('data_auditor', `分析异常: ${type} - ${store}`, ctx);
  }

  // Chairman: 异常→培训联动（独立try，不影响原有流程）
  try {
    const { checkAndTriggerTraining } = await import('../chairman/training-trigger-rules.js');
    await checkAndTriggerTraining(type, store, ctx.severity);
  } catch (e) { /* silent */ }
}

export default {
  handleAnomalies,
  handleTrigger
};
