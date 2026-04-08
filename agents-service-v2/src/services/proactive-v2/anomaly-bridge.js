/**
 * Anomaly Bridge
 *
 * 连接 anomaly-engine 和 proactive 系统
 */

import config from './config.js';
import triggerDedupe from './trigger-dedupe.js';
const { shouldTrigger, recordTrigger } = triggerDedupe;
import llmDecision from './llm-decision.js';
const { decideWithLLM } = llmDecision;
import { dispatchToAgent } from '../agent-handlers.js';

/**
 * 处理异常数组
 * @param {Array} anomalies - 异常数组
 * @returns {Promise<Object>} 处理结果统计
 */
async function handleAnomalies(anomalies) {
  if (!config.enabled) {
    if (config.log) {
      console.log('[Proactive][Bridge] Disabled, skipping');
    }
    return { processed: 0, triggered: 0, skipped: 0 };
  }

  if (!Array.isArray(anomalies) || anomalies.length === 0) {
    if (config.log) {
      console.log('[Proactive][Bridge] No anomalies to process');
    }
    return { processed: 0, triggered: 0, skipped: 0 };
  }

  const stats = {
    processed: 0,
    triggered: 0,
    skipped: 0,
    errors: 0,
  };

  for (const anomaly of anomalies) {
    try {
      stats.processed++;

      // 1. 去重判断
      const shouldTriggerFlag = await shouldTrigger(anomaly);
      if (!shouldTriggerFlag) {
        stats.skipped++;
        continue;
      }

      // 2. LLM 决策
      let decision;
      if (config.useLLM) {
        try {
          decision = await decideWithLLM(anomaly);
        } catch (err) {
          console.error('[Proactive][Bridge] LLM decision error:', err.message);
          // LLM 出错，使用 fallback（已内置）
          decision = await decideWithLLM(anomaly);
        }
      } else {
        // 不使用 LLM，直接触发
        decision = { triggered: true, reason: 'useLLM=false', priority: 'medium' };
      }

      // 3. 如果需要触发
      if (decision.triggered) {
        try {
          const ctx = buildContext(anomaly, decision);
          await handleTrigger(ctx);
          await recordTrigger(anomaly);
          stats.triggered++;
        } catch (err) {
          console.error('[Proactive][Bridge] Handle trigger error:', err.message);
          stats.errors++;
        }
      } else {
        stats.skipped++;
        if (config.log) {
          console.log(`[Proactive][Bridge] Skipped: ${anomaly.store}/${anomaly.type} - ${decision.reason}`);
        }
      }

    } catch (err) {
      console.error('[Proactive][Bridge] Process anomaly error:', err.message);
      stats.errors++;
    }
  }

  if (config.log) {
    console.log(`[Proactive][Bridge] Complete: processed=${stats.processed}, triggered=${stats.triggered}, skipped=${stats.skipped}, errors=${stats.errors}`);
  }

  return stats;
}

/**
 * 构建触发上下文
 */
function buildContext(anomaly, decision) {
  return {
    source: 'proactive',
    type: anomaly.type,
    store: anomaly.store,
    severity: anomaly.severity || decision.priority || 'medium',
    data: {
      ...anomaly,
      llmReason: decision.reason,
      llmPriority: decision.priority,
    },
  };
}

/**
 * 处理触发 - 调用对应的 Agent
 */
async function handleTrigger(ctx) {
  const { type, store } = ctx;

  console.log(`[Proactive Trigger] ${type} at ${store}`);

  // 根据异常类型分发到不同的 Agent
  if (type === 'revenue_drop' || type === 'revenue') {
    // 营收异常
    await dispatchToAgent('data_auditor', `分析营收下降 - ${store}`, ctx);
    await dispatchToAgent('ops_supervisor', `检查运营问题 - ${store}`, ctx);
    await dispatchToAgent('marketing_planner', `制定提升方案 - ${store}`, ctx);

  } else if (type === 'bad_review_spike' || type === 'bad_review_service' || type === 'bad_review_product') {
    // 差评异常
    await dispatchToAgent('food_quality', `分析差评问题 - ${store}`, ctx);
    await dispatchToAgent('ops_supervisor', `检查服务问题 - ${store}`, ctx);

  } else if (type === 'gross_margin') {
    // 毛利率异常
    await dispatchToAgent('data_auditor', `分析毛利率异常 - ${store}`, ctx);
    await dispatchToAgent('procurement_agent', `检查采购成本 - ${store}`, ctx);

  } else if (type === 'labor') {
    // 人工成本异常
    await dispatchToAgent('ops_supervisor', `分析人工成本 - ${store}`, ctx);
    await dispatchToAgent('data_auditor', `检查人工数据 - ${store}`, ctx);

  } else if (type === 'traffic') {
    // 客流异常
    await dispatchToAgent('marketing_planner', `分析客流下降 - ${store}`, ctx);
    await dispatchToAgent('ops_supervisor', `检查运营状况 - ${store}`, ctx);

  } else {
    // 其他异常，默认分发给 data_auditor
    await dispatchToAgent('data_auditor', `分析异常: ${type} - ${store}`, ctx);
  }
}

export default {
  handleAnomalies,
  handleTrigger,
};
