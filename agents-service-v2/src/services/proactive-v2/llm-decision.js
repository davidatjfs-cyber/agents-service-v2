/**
 * LLM Decision — Proactive 专用：DeepSeek → Ollama → 规则兜底（静态 import llm-provider，无循环依赖）
 */

import config from './config.js';
import { callDeepSeek, callOllamaLLM } from '../llm-provider.js';
import { formatProactiveLlmPromptHints } from '../agent-memory.js';

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

function normalizeActions(parsed) {
  const raw = parsed?.actions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === 'string' ? x.trim() : x != null ? String(x).trim() : ''))
    .filter(Boolean);
}

function buildPrompt(anomaly, historyBlock = '') {
  const store = anomaly.store || '';
  const type = anomaly.type || anomaly.rule || 'unknown';
  const severity = anomaly.severity || '';
  let valueStr = '';
  if (anomaly.value != null) {
    valueStr =
      typeof anomaly.value === 'object' ? JSON.stringify(anomaly.value) : String(anomaly.value);
  }

  return `
你是餐饮门店经营执行专家，输出必须能交给店长「按条照做」，禁止空话。
${historyBlock || ''}
当前异常：
门店：${store}
类型：${type}
严重程度：${severity}
数值：${valueStr}

请判断是否需要触发经营动作。若 triggered 为 true，必须给出可执行经营方案。

【actions 硬性要求】
1. 每条动作必须具体：至少包含一类可核对要素——具体价格或折扣数字、具体菜品/套餐/SKU 名称、或具体渠道/场景（如美团/抖音/企微社群/门店午市等）。
2. 禁止抽象表述，例如不得出现：「优化服务」「提升体验」「加强管理」「改善品质」「做好培训」「提高人效」等无法直接落地的句子。
3. 每条应是「谁、在什么场景、做什么、做到什么量化标准」可执行指令；至少 2 条，至多 5 条。
4. 若信息不足，仍须基于类型做合理假设并写清假设（如「假设主力套餐为××价」），不得用模糊词敷衍。

只返回 JSON（不要 Markdown、不要解释）：

{
  "triggered": true,
  "reason": "简短说明原因（一句话）",
  "priority": "high | medium | low",
  "actions": [
    "具体可执行动作1（含价格/菜品/渠道至少其一）",
    "具体可执行动作2"
  ]
}

若无需触发：triggered 为 false，actions 为空数组 []。
`.trim();
}

async function callOllamaProactiveJson(prompt, timeoutMs) {
  const messages = [
    {
      role: 'system',
      content: '你是餐饮经营分析AI，只返回JSON，不要输出 Markdown 或其它说明。'
    },
    { role: 'user', content: prompt }
  ];
  const out = await Promise.race([
    callOllamaLLM(messages, {
      temperature: 0.2,
      max_tokens: 1200,
      purpose: 'proactive_anomaly_decision'
    }),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
  ]);
  if (out === 'timeout') {
    throw new Error('ollama timeout');
  }
  const content = typeof out?.content === 'string' ? out.content : String(out?.content || '');
  if (!out?.ok || !content.trim()) {
    throw new Error(out?.error || 'ollama_empty');
  }
  return content.trim();
}

export async function decideWithLLM(anomaly) {
  if (!config.useLLM) {
    console.log('[LLM SOURCE]', 'rule');
    return fallbackDecision(anomaly);
  }

  if (config.testMode) {
    if (config.log) {
      console.log('[Proactive][LLM] testMode — skip real LLM');
    }
    console.log('[LLM SOURCE]', 'test');
    return {
      triggered: true,
      reason: 'test mode',
      priority: 'high',
      actions: []
    };
  }

  const historyBlock = await formatProactiveLlmPromptHints(anomaly.store || '');
  const prompt = buildPrompt(anomaly, historyBlock);
  const timeoutMs = config.llm.timeout || 4000;
  const preferDeepSeek = config.proactiveLLMProvider === 'deepseek';

  let raw = '';
  let source = 'unknown';

  if (preferDeepSeek) {
    try {
      raw = await callDeepSeek(prompt, { timeoutMs });
      source = 'deepseek';
    } catch (e1) {
      console.warn('[LLM] DeepSeek failed → fallback to Ollama', e1?.message || e1);
      try {
        raw = await callOllamaProactiveJson(prompt, timeoutMs);
        source = 'ollama';
      } catch (e2) {
        console.warn('[LLM] Ollama failed → fallback to rule', e2?.message || e2);
        console.log('[LLM SOURCE]', 'rule');
        return fallbackDecision(anomaly);
      }
    }
  } else {
    try {
      raw = await callOllamaProactiveJson(prompt, timeoutMs);
      source = 'ollama';
    } catch (e2) {
      console.warn('[LLM] Ollama failed → fallback to rule', e2?.message || e2);
      console.log('[LLM SOURCE]', 'rule');
      return fallbackDecision(anomaly);
    }
  }

  console.log('[LLM SOURCE]', source);
  console.log('[LLM RAW]', String(raw).slice(0, 2000));

  const parsed = safeParseJSON(raw);

  console.log('[LLM PARSED]', parsed);

  if (!parsed || typeof parsed.triggered !== 'boolean') {
    console.warn('[LLM] invalid output → fallback');
    console.log('[LLM SOURCE]', 'rule');
    return fallbackDecision(anomaly);
  }

  return {
    triggered: parsed.triggered === true,
    reason: parsed.reason || 'no reason',
    priority: ['low', 'medium', 'high'].includes(String(parsed.priority))
      ? parsed.priority
      : 'medium',
    actions: normalizeActions(parsed)
  };
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
      priority: 'high',
      actions: []
    };
  }

  if (type === 'revenue_drop' || type === 'revenue') {
    const dropPercent = extractPercentage(value);
    if (dropPercent !== null && dropPercent > revenueDropThreshold) {
      return {
        triggered: true,
        reason: `营收下降${dropPercent}%超过阈值`,
        priority: 'high',
        actions: []
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
        priority: 'high',
        actions: []
      };
    }
  }

  if (type === 'gross_margin') {
    return { triggered: true, reason: '毛利率异常需分析', priority: 'high', actions: [] };
  }

  if (type === 'labor' || type === 'labor_cost' || type === 'labor_efficiency') {
    return { triggered: true, reason: '人工/人效异常', priority: 'medium', actions: [] };
  }

  if (type === 'traffic' || type === 'customer_flow') {
    return { triggered: true, reason: '客流异常需分析', priority: 'medium', actions: [] };
  }

  if (type === 'recharge_zero' || type === 'recharge') {
    return { triggered: true, reason: '充值数据异常', priority: 'medium', actions: [] };
  }

  const seriousRules =
    /revenue_achievement|food_safety|table_visit|recharge_zero/i;
  if (type && seriousRules.test(type) && anomaly.triggered) {
    return {
      triggered: true,
      reason: '业务规则命中（兜底）',
      priority: 'medium',
      actions: []
    };
  }

  return {
    triggered: false,
    reason: '未达到触发条件',
    priority: 'low',
    actions: []
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
