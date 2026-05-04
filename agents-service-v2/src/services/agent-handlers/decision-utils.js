/**
 * Decision utilities extracted from agent-handlers.js
 * V2 aligned with V1 data sources & reply templates (2026-03-08)
 *
 * 从 agent-handlers.js 提取。导入方请从 agent-handlers.js（barrel）统一导入。
 * import { detectDecisionMode, ... } from '../agent-handlers.js'
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { callLLM } from '../llm-provider.js';
import { getStrategyStats, extractStructuredData } from '../knowledge/index.js';

export function detectDecisionMode(text = '') {
  const t = String(text || '');
  const decisionKeywords = [
    '为什么',
    '原因',
    '怎么办',
    '如何',
    '策略',
    '优化',
    '提升',
    '问题',
    '下降',
    '增长'
  ];
  const dataKeywords = ['多少', '数据', '营业额', '明细', '报表', '昨天', '今天', '本周'];

  if (decisionKeywords.some((k) => t.includes(k))) {
    return 'decision';
  }
  if (dataKeywords.some((k) => t.includes(k))) {
    return 'data';
  }
  return 'decision';
}

/** 从注入的 ds 中解析「当前最优策略」及首条统计行的 weightedScore / 成功率 / 趋势 */
function parseStrategyHeadFromDs(ds) {
  const s = String(ds || '');
  const opt = s.match(/当前最优策略：\s*([^\n]+)/);
  const action = opt ? opt[1].trim() : '';
  const wsM = s.match(/weightedScore\s+([0-9.]+)/);
  const pctM = s.match(/成功率\s+(\d+)%/);
  const trM = s.match(/趋势\s+([^\s｜）\n]+)/);
  return {
    action: action || '先完成营业数据补录与凭据核对',
    ws: wsM ? wsM[1] : '0.50',
    sr: pctM ? pctM[1] : '0',
    tr: trM ? trM[1] : 'stable'
  };
}

function stripReportStyleEnding(response) {
  let s = String(response || '').trim();
  s = s.replace(/(需要持续观察|建议关注|可以进一步分析)[。．…\s]*$/g, '').trim();
  return s;
}

function trimMultiSuggestions(response) {
  const keywords = ['另外', '此外', '同时', '也可以'];
  let earliest = -1;
  const str = String(response);
  for (const k of keywords) {
    const i = str.indexOf(k);
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i;
  }
  if (earliest === -1) return str;
  return str.slice(0, earliest).trim();
}

/** decision 模式：单一可执行动作 + 去多建议连接词 + 去报表式结尾；缺「今日重点动作」时用策略统计兜底 */
async function coerceDecisionExecutionOutput(response, mode, store, text) {
  if (mode !== 'decision') return stripReportStyleEnding(String(response || '').trim());
  let out = stripReportStyleEnding(String(response || '').trim());
  if (!out.includes('今日重点动作')) {
    let stats = [];
    if (store) {
      try {
        stats = await getStrategyStats({ store, problem: String(text || '').slice(0, 120) });
      } catch (_) {}
    }
    const best = stats[0];
    const ws =
      best?.weightedScore != null && !Number.isNaN(Number(best.weightedScore))
        ? Number(best.weightedScore).toFixed(2)
        : '0.50';
    const pct = Math.round((best?.successRate ?? 0) * 100);
    const trend = best?.trend != null ? String(best.trend) : 'stable';
    const act = best?.action != null ? String(best.action).trim() : '先完成营业数据补录与凭据核对';
    const why = best
      ? '引用经验：本条为策略统计中 policyScore／weightedScore 与趋势综合排序首位。'
      : '引用经验：暂无足够策略样本；优先补齐数据与地面动作，再量化比较。';
    out = `【核心问题】\n当前存在关键运营问题\n\n【今日重点动作】\n${act}\n（weightedScore ${ws}｜成功率 ${pct}%｜趋势 ${trend}）\n\n【为什么是这个动作】\n${why}\n\n【执行要求】\n店长今日内必须完成执行并记录结果，便于系统更新 outcome。`;
  }
  out = trimMultiSuggestions(out);
  out = stripReportStyleEnding(out);
  return out;
}

function extractDataAuditorOutcomeFields(response, mode) {
  const r = String(response || '');
  if (mode === 'decision' && /【今日重点动作】/.test(r)) {
    const probM = r.match(/【核心问题】\s*([\s\S]*?)(?=\n【今日重点动作】|$)/);
    const actM = r.match(/【今日重点动作】\s*([\s\S]*?)(?=\n【为什么是这个动作】|$)/);
    const causeM = r.match(/【为什么是这个动作】\s*([\s\S]*?)(?=\n【执行要求】|$)/);
    const problem = probM ? probM[1].trim().slice(0, 500) : '';
    const action = actM ? actM[1].trim().slice(0, 500) : '';
    const cause = causeM ? causeM[1].trim().slice(0, 500) : '';
    return {
      problem: problem || r.slice(0, 200).slice(0, 500),
      cause,
      action: action || cause.slice(0, 500)
    };
  }
  return extractStructuredData(r);
}

/** 已注入 Wiki 但模型未输出执行化结构时，用历史经验 + 策略统计生成合规回答（不编造数字） */
function buildWikiComplianceFallback(ds, text, store) {
  const m = String(ds || '').match(/- 结论：[^\n]+/);
  const quote = m ? m[0].replace(/^- 结论：/, '').trim().slice(0, 200) : '系统提供的历史经验摘要。';
  const core = /下降|下滑|变差/.test(String(text || ''))
    ? '营业额下滑的主因在当前会话中无法仅凭数据库确认（缺凭证）'
    : '核心问题需结合门店数据进一步确认（当前缺凭证）';
  const st = parseStrategyHeadFromDs(ds);
  const hasStats = String(ds).includes('【策略效果统计】');
  const whyStats = hasStats
    ? `引用经验：${quote}。策略统计上「${st.action}」的 weightedScore 为 ${st.ws}、成功率 ${st.sr}%、趋势 ${st.tr}，policyScore 排序为首，故作为唯一执行项。`
    : `引用经验：${quote}。当前策略样本不足，优先完成凭证与日报补录，再据实迭代。`;

  return (
    `【核心问题】\n${core}\n\n` +
    `【今日重点动作】\n${st.action}\n（weightedScore ${st.ws}｜成功率 ${st.sr}%｜趋势 ${st.tr}）\n\n` +
    `【为什么是这个动作】\n${whyStats}\n\n` +
    `【执行要求】\n店长须于今日营业结束前落实上述动作，并在系统记录执行结果；门店「${store || '门店'}」负责人对验收留痕负责。`
  );
}

function zhOnlyDataAuditorNarrative(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const wikiCut = s.search(/【引用经验】/);
  if (wikiCut >= 0) return s.slice(wikiCut).trim();
  const cut = s.search(
    /【问题分析】|^\s*\*?\*?问题分析\*?\*?\s*[:：]?/m
  );
  if (cut >= 0) return s.slice(cut).trim();
  const cutEn = s.search(
    /(?:^|\n)\s*\*?\*?(?:Problem\s+Analysis|Key\s+Issues)\*?\*?\s*[:\s]*/i
  );
  if (cutEn >= 0) return s.slice(cutEn).trim();
  const cut2 = s.search(/【行动建议】|^\s*\*?\*?行动建议\*?\*?\s*[:：]?/m);
  if (cut2 >= 0) return s.slice(cut2).trim();
  const cutEn2 = s.search(
    /(?:^|\n)\s*\*?\*?(?:Actionable\s+Advice|Recommended\s+Actions|Action\s+Plan)\*?\*?\s*[:\s]*/i
  );
  if (cutEn2 >= 0) return s.slice(cutEn2).trim();
  const lines = s.split(/\r?\n/);
  const out = [];
  let keep = false;
  for (const line of lines) {
    const t = line.trim();
    if (!keep) {
      if (!t) continue;
      if (/^(role|input data|constraints|user question|logic|analysis)\s*:/i.test(t)) continue;
      if (/^#{1,6}\s*(role|input|constraint|user question)/i.test(t)) continue;
      if (/[一-鿿]/.test(t) || /^【/.test(t)) keep = true;
      if (keep) out.push(line);
    } else {
      out.push(line);
    }
  }
  const joined = out.join('\n').trim();
  return joined || s;
}

/** 检测输出是否含英文（任一条件满足即认为需要重写） */
function containsSignificantEnglish(s) {
  const body = String(s || '');
  if (/Problem\s+Analysis|Actionable\s+Advice|No empty words like|responsible person|Delivery Ratio|Dine-in.*Revenue|User Role|Next Steps/i.test(body)) return true;
  const totalChars = body.replace(/\s/g, '').length;
  if (totalChars < 10) return false;
  const latinChars = (body.match(/[a-zA-Z]/g) || []).length;
  return latinChars / totalChars > 0.08;
}

async function coerceMonthComparisonAdviceToZh(text, llmContext) {
  const cleaned = zhOnlyDataAuditorNarrative(text);
  if (!containsSignificantEnglish(cleaned)) return cleaned;
  try {
    const tr = await callLLM(
      [
        {
          role: 'system',
          content:
            '你是简体中文编辑。将下面的分析文本**全部改写为简体中文**，保留所有金额数字和百分比。\n' +
            '输出只能包含两段，标题格式固定为：\n【问题分析】\n【行动建议】\n' +
            '每段下面用 1. 2. 3. 编号列出对应内容。\n' +
            '严禁输出任何英文单词、英文标题或元信息说明。'
        },
        { role: 'user', content: cleaned.slice(0, 5000) }
      ],
      {
        temperature: 0.1,
        max_tokens: 800,
        purpose: 'data_auditor',
        ...(llmContext ? { context: llmContext } : {})
      }
    );
    const o = String(tr.content || '').trim();
    return o ? zhOnlyDataAuditorNarrative(o) : cleaned;
  } catch (e) {
    logger.warn({ err: e?.message }, 'coerceMonthComparisonAdviceToZh rewrite failed');
    return cleaned;
  }
}

// ── 决策日志工具（永久存档 + 主动引用）────────────────────────
async function logDecision({ store, brand = '', decisionType = 'action_plan', title, content, agent = '', sourceTaskId = '', createdBy = '' }) {
  try {
    await query(
      `INSERT INTO decision_log (store, brand, decision_type, title, content, agent, source_task_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [store, brand || '', decisionType, title, content, agent, sourceTaskId || '', createdBy || '']
    );
  } catch (e) {
    logger.warn({ err: e?.message }, 'logDecision failed');
  }
}

async function recallDecisions(store, limit = 5) {
  try {
    const r = await query(
      `SELECT decision_type, title, content, agent, created_at
       FROM decision_log WHERE store = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT $2`,
      [store, limit]
    );
    return r.rows || [];
  } catch (e) { return []; }
}

function formatDecisionHistory(decisions) {
  if (!decisions?.length) return '';
  const TYPE_LABEL = { action_plan: '行动计划', marketing: '营销决策', operation: '运营决策', review: '评估记录' };
  return decisions.map(d => {
    const label = TYPE_LABEL[d.decision_type] || d.decision_type;
    const date = String(d.created_at || '').slice(0, 10);
    return `· [${date}][${label}] ${d.title}：${d.content.slice(0, 120)}${d.content.length > 120 ? '…' : ''}`;
  }).join('\n');
}

/** 验证完成后改为 false，仅当用户句中含 执行|效果|策略|报告 时合并 data_auditor */
export const MERGE_DECISION_ALWAYS_FOR_MARKETING_REPORT = true;

export {
  parseStrategyHeadFromDs,
  stripReportStyleEnding,
  trimMultiSuggestions,
  coerceDecisionExecutionOutput,
  extractDataAuditorOutcomeFields,
  buildWikiComplianceFallback,
  zhOnlyDataAuditorNarrative,
  containsSignificantEnglish,
  coerceMonthComparisonAdviceToZh,
  logDecision,
  recallDecisions,
  formatDecisionHistory
};
