/**
 * LLM Decision — 动态 import llm-provider，短超时 + 安全 JSON 解析
 */

import config from './config.js';

export function safeParseJSON(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        console.error('[Proactive][LLM] JSON extract failed', match[0].slice(0, 200));
      }
    }
    return null;
  }
}

async function callLLMForAnomaly(prompt) {
  const { callLLM } = await import('../llm-provider.js');
  const out = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是餐饮经营分析决策助手。只根据用户给出的异常摘要输出 JSON，不要输出任何其它文字或 Markdown。'
      },
      { role: 'user', content: prompt }
    ],
    {
      temperature: 0.1,
      max_tokens: 400,
      purpose: 'proactive_anomaly_decision',
      context: { intent: 'query', complexity: 'low', mode: 'single' }
    }
  );

  const content = typeof out?.content === 'string' ? out.content : String(out?.content || '');
  if (!content && !out?.ok) {
    throw new Error(out?.error || 'llm_empty');
  }
  return content;
}

function buildPrompt(anomaly) {
  const type = anomaly.type || anomaly.rule || 'unknown';
  const store = anomaly.store || '';
  const severity = anomaly.severity || '';
  let valueDesc = '';
  const value = anomaly.value;
  if (value != null) {
    valueDesc = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  return `你是餐饮经营分析专家。请判断以下异常是否需要触发主动分析（通知、任务、Agent 协作）。

输入信息：
- 异常类型: ${type}
- 门店: ${store}
- 严重程度: ${severity}
- 指标数据: ${valueDesc}

判断参考：
- 营收明显下降、差评激增、毛利率异常、食安、人效/客流明显异常 → 倾向触发
- 已标记为重复/待数据类可倾向不触发（由系统已过滤大部分）

⚠️ 只返回 JSON，不要解释：

{
  "triggered": true,
  "reason": "...",
  "priority": "high"
}

priority 取值仅限: low | medium | high`;
}

export async function decideWithLLM(anomaly) {
  if (config.testMode) {
    console.log('[Proactive][LLM] testMode — skip real LLM');
    return {
      triggered: true,
      reason: 'test mode',
      priority: 'high'
    };
  }

  const prompt = buildPrompt(anomaly);
  const timeoutMs = config.llm.timeout || 2000;

  try {
    const raw = await Promise.race([
      callLLMForAnomaly(prompt),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
    ]);

    console.log('[Proactive][LLM] RAW', String(raw).slice(0, 500));

    if (raw === 'timeout') {
      console.warn('[Proactive][LLM] timeout fallback');
      return fallbackDecision(anomaly);
    }

    const parsed = safeParseJSON(raw);

    console.log('[Proactive][LLM] PARSED', parsed);

    if (!parsed || typeof parsed.triggered !== 'boolean') {
      console.warn('[Proactive][LLM] invalid output fallback');
      return fallbackDecision(anomaly);
    }

    return {
      triggered: parsed.triggered === true,
      reason: parsed.reason || 'no reason',
      priority: ['low', 'medium', 'high'].includes(String(parsed.priority))
        ? parsed.priority
        : 'medium'
    };
  } catch (err) {
    console.error('[Proactive][LLM] error', err?.message || err);
    return fallbackDecision(anomaly);
  }
}

export function fallbackDecision(anomaly) {
  const type = anomaly.type || anomaly.rule || '';
  const { revenueDropThreshold, badReviewSpikeThreshold } = config.llm;
  const sev = String(anomaly.severity || '').toLowerCase();
  const value = anomaly.value;

  if (['high', 'critical', '严重'].some((x) => sev.includes(x))) {
    return {
      triggered: true,
      reason: '严重程度较高（规则兜底）',
      priority: 'high'
    };
  }

  if (type === 'revenue_drop' || type === 'revenue') {
    const dropPercent = extractPercentage(value);
    if (dropPercent !== null && dropPercent > revenueDropThreshold) {
      return {
        triggered: true,
        reason: `营收下降${dropPercent}%超过阈值`,
        priority: 'high'
      };
    }
  }

  if (
    type === 'bad_review_spike' ||
    type === 'bad_review_service' ||
    type === 'bad_review_product' ||
    type === 'bad_review'
  ) {
    const count = extractCount(value);
    if (count !== null && count >= badReviewSpikeThreshold) {
      return {
        triggered: true,
        reason: `差评${count}条超过阈值`,
        priority: 'high'
      };
    }
  }

  if (type === 'gross_margin') {
    return { triggered: true, reason: '毛利率异常需分析', priority: 'high' };
  }

  if (type === 'labor' || type === 'labor_cost' || type === 'labor_efficiency') {
    return { triggered: true, reason: '人工/人效异常', priority: 'medium' };
  }

  if (type === 'traffic' || type === 'customer_flow') {
    return { triggered: true, reason: '客流异常需分析', priority: 'medium' };
  }

  if (type === 'recharge_zero' || type === 'recharge') {
    return { triggered: true, reason: '充值数据异常', priority: 'medium' };
  }

  const seriousRules =
    /revenue_achievement|food_safety|table_visit|recharge_zero/i;
  if (type && seriousRules.test(type) && anomaly.triggered) {
    return {
      triggered: true,
      reason: '业务规则命中（兜底）',
      priority: 'medium'
    };
  }

  return {
    triggered: false,
    reason: '未达到触发条件',
    priority: 'low'
  };
}

function extractPercentage(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value) {
    if (value.drop_percent != null) return Number(value.drop_percent);
    if (value.percent != null) return Number(value.percent);
  }
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

function extractCount(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value) {
    if (value.count != null) return Number(value.count);
    if (value.review_count != null) return Number(value.review_count);
  }
  const match = String(value).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export default {
  decideWithLLM,
  fallbackDecision,
  safeParseJSON
};
