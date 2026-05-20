/**
 * LLM Decision — Proactive 专用：Qwen(首选) → DeepSeek → Ollama → 规则兜底
 */

import { getProactiveConfig } from './config.js';
import { callDeepSeek, callOllamaLLM, callLLM } from '../llm-provider.js';
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

/**
 * LLM/规则兜底在 triggered=true 时必须给出可执行动作，否则 proactive 不会建 PLLM 任务卡。
 * 每条含门店名 + 数字或渠道，满足 buildPrompt 的可核对要求。
 */
export function fallbackActionsForAnomaly(anomaly) {
  const store = String(anomaly?.store || '本门店').trim() || '本门店';
  const type = String(anomaly?.type || anomaly?.rule || '').toLowerCase();
  const sev = String(anomaly?.severity || '').toLowerCase();

  if (/recharge|充值/.test(type)) {
    return [
      `在企微社群推送「${store}」储值满500元送80元券包（券包有效期14天），当日22:00前统计新增储值笔数并截图发营运群`,
      `检查${store}收银台美团/抖音核销入口：11:00-13:00、17:00-19:00各抽30分钟现场拍照，记录异常笔数`
    ];
  }
  if (/bad_review|差评/.test(type)) {
    return [
      `打开大众点评${store}近7天新增差评，逐条复制首条差评全文到飞书「差评台账」，并标出出现最多的关键词1个`,
      `针对上述关键词，店长手写3条整改动作（每条≤35字，含责任岗位+完成日），当日18:00前发飞书`
    ];
  }
  if (/margin|毛利|gross/.test(type)) {
    return [
      `导出${store}近14天菜品销售明细（含成本价字段），标出毛利率低于45%的SKU前5名并附销售额`,
      `对上述SKU中Top2制定「周内调价或套餐重组」方案：写出原价¥?、新价¥?或新套餐名，3日内执行`
    ];
  }
  if (/labor|人效|人工/.test(type)) {
    return [
      `统计${store}本周排班表：每日高峰时段（11:30-13:30、17:30-20:00）在岗人数与营业额，填表并附1张现场照片`,
      `若午市人效低于上周同期10%以上，列出2条可执行排班调整（具体到时段与人数），次日执行并复盘`
    ];
  }
  if (/traffic|客流/.test(type)) {
    return [
      `在美团/抖音上架「${store}」午市双人套餐¥88（原价标注¥108），连续投放7天，每日截图曝光与核销数`,
      `本周内完成3次店门口10分钟客流计数（12:00/18:00/20:00），数字填入「客流登记表」并发群`
    ];
  }
  if (/revenue|营收|达成/.test(type)) {
    return [
      `盘点${store}近7天午市（11:00-14:00）实收与订单数，与再上一周同日对比，列出跌幅>8%的2个具体时段`,
      `针对跌幅最大时段，推出限时单品（写明菜品名+折后价¥?），连续执行5天并每日汇报核销单数`
    ];
  }
  if (/food_safety|食安/.test(type)) {
    return [
      `当日闭店前完成${store}冷柜温度记录2次（拍照含温度计读数℃），异常立即报总部营运`,
      `后厨解冻/留样记录补齐近3天台账（日期+品名+克数），拍照存档并发营运群备查`
    ];
  }
  if (/table_visit|桌访/.test(type)) {
    return [
      `从桌访系统导出${store}本周差评菜品Top3（含菜品名与出现次数），店长与出品经理各写1条整改动作（≤40字）`,
      `对上述Top1菜品连续3天出品拍照（同一角度），标注时间与当班出品负责人姓名`
    ];
  }

  const sevHint = /high|critical|严重/.test(sev) ? '（高优先级）' : '';
  return [
    `今日18:00前完成${store}堂食客流踏勘：每整点计数15分钟${sevHint}，填「客流踏勘表」并附门店门口照片1张`,
    `盘点${store}大众点评近7天新增评价中关键词Top2，各写1条可执行整改（含责任岗位+完成日期），发飞书营运群`
  ];
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
      max_tokens: 800,
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
  const config = await getProactiveConfig();
  if (!config.useLLM) {
    console.log('[LLM SOURCE]', 'rule');
    return fallbackDecision(anomaly, config);
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
      actions: fallbackActionsForAnomaly(anomaly)
    };
  }

  const historyBlock = await formatProactiveLlmPromptHints(anomaly.store || '');
  const prompt = buildPrompt(anomaly, historyBlock);
  const timeoutMs = config.llm.timeout || 4000;
  const provider = config.proactiveLLMProvider;

  let raw = '';
  let source = 'unknown';

  const callQwenProactiveJson = async (p, t) => {
    const messages = [
      { role: 'system', content: '你是餐饮经营分析AI，只返回JSON，不要输出 Markdown 或其它说明。' },
      { role: 'user', content: p }
    ];
    const resp = await callLLM(messages, { temperature: 0.2, max_tokens: 800, skipCache: true, model: 'qwen-max' });
    if (!resp?.ok || !resp?.content) throw new Error(resp?.error || 'qwen_empty');
    return resp.content.trim();
  };

  if (provider === 'qwen') {
    try {
      raw = await callQwenProactiveJson(prompt, timeoutMs);
      source = 'qwen';
    } catch (e1) {
      console.warn('[LLM] Qwen failed → fallback to DeepSeek', e1?.message || e1);
      try {
        raw = await callDeepSeek(prompt, { timeoutMs });
        source = 'deepseek';
      } catch (e2) {
        console.warn('[LLM] DeepSeek failed → fallback to Ollama', e2?.message || e2);
        try {
          raw = await callOllamaProactiveJson(prompt, timeoutMs);
          source = 'ollama';
        } catch (e3) {
          console.warn('[LLM] Ollama failed → fallback to rule', e3?.message || e3);
          console.log('[LLM SOURCE]', 'rule');
          return fallbackDecision(anomaly, config);
        }
      }
    }
  } else if (provider === 'deepseek') {
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
        return fallbackDecision(anomaly, config);
      }
    }
  } else {
    try {
      raw = await callOllamaProactiveJson(prompt, timeoutMs);
      source = 'ollama';
    } catch (e2) {
      console.warn('[LLM] Ollama failed → fallback to DeepSeek', e2?.message || e2);
      try {
        raw = await callDeepSeek(prompt, { timeoutMs });
        source = 'deepseek';
      } catch (e3) {
        console.warn('[LLM] DeepSeek failed → fallback to rule', e3?.message || e3);
        console.log('[LLM SOURCE]', 'rule');
        return fallbackDecision(anomaly, config);
      }
    }
  }

  console.log('[LLM SOURCE]', source);
  console.log('[LLM RAW]', String(raw).slice(0, 2000));

  const parsed = safeParseJSON(raw);

  console.log('[LLM PARSED]', parsed);

  if (!parsed || typeof parsed.triggered !== 'boolean') {
    console.warn('[LLM] invalid output → fallback');
    console.log('[LLM SOURCE]', 'rule');
    return fallbackDecision(anomaly, config);
  }

  let actions = normalizeActions(parsed);
  if (parsed.triggered === true && actions.length === 0) {
    actions = fallbackActionsForAnomaly(anomaly);
  }

  return {
    triggered: parsed.triggered === true,
    reason: parsed.reason || 'no reason',
    priority: ['low', 'medium', 'high'].includes(String(parsed.priority))
      ? parsed.priority
      : 'medium',
    actions
  };
}

export function fallbackDecision(anomaly, cfg) {
  const type = anomaly.type || anomaly.rule || '';
  const active = cfg && cfg.llm ? cfg : { llm: { revenueDropThreshold: 20, badReviewSpikeThreshold: 5 } };
  const { revenueDropThreshold, badReviewSpikeThreshold } = active.llm;
  const sev = String(anomaly.severity || '').toLowerCase();
  const value = anomaly.value;

  const fa = () => fallbackActionsForAnomaly(anomaly);

  if (['high', 'critical', '严重'].some((x) => sev.includes(x))) {
    return {
      triggered: true,
      reason: '严重程度较高（规则兜底）',
      priority: 'high',
      actions: fa()
    };
  }

  if (type === 'revenue_drop' || type === 'revenue') {
    const dropPercent = extractPercentage(value);
    if (dropPercent !== null && dropPercent > revenueDropThreshold) {
      return {
        triggered: true,
        reason: `营收下降${dropPercent}%超过阈值`,
        priority: 'high',
        actions: fa()
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
        actions: fa()
      };
    }
  }

  if (type === 'gross_margin') {
    return { triggered: true, reason: '毛利率异常需分析', priority: 'high', actions: fa() };
  }

  if (type === 'labor' || type === 'labor_cost' || type === 'labor_efficiency') {
    return { triggered: true, reason: '人工/人效异常', priority: 'medium', actions: fa() };
  }

  if (type === 'traffic' || type === 'customer_flow') {
    return { triggered: true, reason: '客流异常需分析', priority: 'medium', actions: fa() };
  }

  if (type === 'recharge_zero' || type === 'recharge') {
    return { triggered: true, reason: '充值数据异常', priority: 'medium', actions: fa() };
  }

  const seriousRules =
    /revenue_achievement|food_safety|table_visit|recharge_zero/i;
  if (type && seriousRules.test(type) && anomaly.triggered) {
    return {
      triggered: true,
      reason: '业务规则命中（兜底）',
      priority: 'medium',
      actions: fa()
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
  safeParseJSON,
  fallbackActionsForAnomaly
};
