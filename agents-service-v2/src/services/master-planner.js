/**
 * Master Planner — Planner 层（不替代原 router/handler）
 *
 * 目标：
 * 1) 意图识别：数据查询/异常分析/经营分析/操作请求（现阶段重点经营分析）
 * 2) 是否需要任务拆解：经营/异常/多步骤 => workflow
 * 3) 生成任务链 + 执行任务链（fetch_data -> analyze_business -> generate_suggestion）
 *
 * 注意：
 * - 不推翻既有 agent-handlers 主流程
 * - 仅在需要时接管“经营分析相关”的 workflow
 */

import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';
import { callLLM } from './llm-provider.js';
import { extractTimeRangeFromText, parseTimeRange, executeMetrics, getAllMetricDefs } from './data-executor.js';
import { estimateCostAndProfitForStore } from './margin-from-sales.js';
import { analyzeDailyBusiness } from './report-handler.js';
import { buildBusinessPrompt } from './llm-provider.js';
import { createTask, transitionTask } from './task-state-machine.js';

/**
 * 从 LLM 响应中去除意外输出的 JSON 块，确保飞书消息里只有自然语言。
 * 优先提取【给用户的结论】或【行动建议】后的文本；兜底则去除 JSON 花括号块。
 */
function stripJsonFromLLMResponse(text) {
  if (!text) return text;
  // 优先：提取"【给用户的结论】"后的部分（旧版 dual-output 格式）
  const conclusionMarker = '【给用户的结论】';
  const markerIdx = text.indexOf(conclusionMarker);
  if (markerIdx !== -1) {
    return text.slice(markerIdx + conclusionMarker.length).trim();
  }
  // 去除 markdown 代码块中的 JSON
  let cleaned = text.replace(/```(?:json)?\s*[\s\S]*?```/g, '').trim();
  // 去除独立 JSON 对象（以 { 开头的行，包含 "summary" 或 "problems" 关键字的块）
  cleaned = cleaned.replace(/\{[\s\S]*?"(?:summary|problems|actions|needs_task|needs_approval)"[\s\S]*?\}/g, '').trim();
  return cleaned || text;
}

/**
 * 纯自然语言系统提示尾部（取代旧版 DUAL_OUTPUT_SYSTEM_PROMPT_TAIL）
 * 旧版要求 AI 先输出 JSON 再输出自然语言，导致飞书消息里出现原始 JSON 块，已废弃。
 */
const DUAL_OUTPUT_SYSTEM_PROMPT_TAIL = `
输出格式要求（严格遵守，违反则判定失败）：
- 只输出中文自然语言，禁止输出任何 JSON、代码块、花括号结构
- 必须包含三个分区标题：【经营总结】【问题分析】【行动建议】
- 【行动建议】下每条动作必须编号（1. 2. ...），并注明谁做、做什么、何时完成
- 禁止空话，如优化提升等，代之以具体动作
- 当动作涉及排班/采购/成本变更时，在【问题分析】说明风险原因
`;

function isBusinessAnomalyQuery(text) {
  const t = String(text || '');
  const hasWhy = /(为什么|为何|原因)/.test(t);
  const hasDown = /(下滑|下降|下跌|趋势|不景气|走低)/.test(t);
  const hasBiz = /(利润|营收|毛利|毛利率|赚钱)/.test(t);
  // 勿用泛泛的「桌访」触发 workflow，否则 Planner 抢先返回、跳过确定性合并（table_visit_records+飞书），条数会偏少
  const hasTableMetric = /(翻台率|桌访率|桌访占比|桌访产品)/.test(t);
  const hasLow = /(不足|偏低|走低)/.test(t);
  return (hasWhy || hasDown) && (hasBiz || hasTableMetric) || (hasTableMetric && hasLow);
}

function isOperationRequest(text) {
  return /(调整|改).*(排班|排班表|班次|调班|增加|减少).*(人员|门店|班)/.test(text);
}

function buildPlan(text, ctx) {
  const t = String(text || '');
  const store = ctx?.store || '';

  if (!store) {
    return { mode: 'single', intent: 'query', complexity: 'low', reason: 'no_store' };
  }

  // 纯「昨天/前天生意怎么样」走确定性营业日报（与 data_auditor 一致），勿在此拦截以免时区/数据源与主链路不一致
  const needWorkflow = isBusinessAnomalyQuery(t) || isOperationRequest(t);
  if (!needWorkflow) {
    return { mode: 'single', intent: 'query', complexity: 'low', reason: 'no_workflow_intent' };
  }

  let intent = 'query';
  let complexity = 'medium';
  if (isOperationRequest(t)) {
    intent = 'action';
    complexity = 'high';
  } else if (isBusinessAnomalyQuery(t)) {
    intent = 'analysis';
    complexity = 'high';
  }

  // 当前版本只强制经营分析链（操作请求先走单路由，由原系统处理）
  // 异常分析也会走同一条链：fetch_data -> analyze_business -> generate_suggestion
  return {
    mode: 'workflow',
    intent,
    complexity,
    goal: isBusinessAnomalyQuery(t) ? '分析经营异常并给出建议' : '查询经营数据并给出建议',
    tasks: [
      { type: 'fetch_data', handler: 'data-executor', input: {} },
      { type: 'analyze_business', handler: 'report-handler', input: {} },
      { type: 'generate_suggestion', handler: 'llm', input: { tone: '务实、可执行、避免空话' } }
    ]
  };
}

function ensureMinActionsText(suggestionsText, fallbackActions) {
  const t = String(suggestionsText || '');
  // 简单校验：是否存在 1. / 2. 这种动作编号
  const has1 = /\\n\\s*1\\./.test(t) || t.startsWith('1.');
  const has2 = /\\n\\s*2\\./.test(t) || t.includes('2.');
  const ok = has1 && has2;
  if (ok) return t;

  const safeActions = Array.isArray(fallbackActions) ? fallbackActions : [];
  while (safeActions.length < 2) safeActions.push('安排当日复盘并记录原因，形成可执行清单（今天完成）');
  const acts = safeActions.slice(0, 2).map((a, i) => `${i + 1}. ${a}`);
  return `【经营总结】昨日经营数据已分析完成。\n【问题分析】暂无可识别的明确异常（或数据不足）。\n【行动建议】\n${acts.join('\n')}`;
}

async function fetchDailyBusinessData(store, timeRange) {
  const { start, end } = parseTimeRange(timeRange);

  // 1) 优先：sales_raw + dish_library_costs => revenue/cost（不依赖 daily_reports）
  let revenue = 0;
  let cost = 0;
  try {
    const est = await estimateCostAndProfitForStore(store, start, end);
    revenue = Number(est?.revenueTotal || 0);
    cost = Number(est?.costTotal || 0);
  } catch (_) { /* ignore */ }

  // 2) 客单/翻台：先从 sales_raw 推 dineQty，再用桌访桌数估算翻台
  let avgTicket = null;
  let tableTurnover = null;
  let dineQty = null;

  try {
    const rSales = await query(
      `SELECT
         SUM(CASE
               WHEN lower(regexp_replace(coalesce(biz_type,''),'\\s+','','g')) IN ('dinein','dine_in','堂食','店内','堂食点餐')
               THEN COALESCE(qty,0)
               ELSE 0
             END)::numeric AS dine_qty,
         SUM(CASE
               WHEN lower(regexp_replace(coalesce(biz_type,''),'\\s+','','g')) IN ('dinein','dine_in','堂食','店内','堂食点餐')
               THEN COALESCE(revenue, sales_amount, 0)
               ELSE 0
             END)::numeric AS dine_rev
       FROM sales_raw
       WHERE date BETWEEN $1::date AND $2::date
         AND lower(regexp_replace(coalesce(store,''),'\\s+','','g')) LIKE $3`,
      [start, end, `%${String(store).trim().replace(/\\s+/g,'') }%`]
    );
    dineQty = Number(rSales.rows?.[0]?.dine_qty || 0);
    const dineRev = Number(rSales.rows?.[0]?.dine_rev || 0);
    if (dineQty > 0 && dineRev > 0) avgTicket = dineRev / dineQty;
  } catch (e) {
    // Fallback：daily_reports
    try {
      const r = await query(
        `SELECT
           COALESCE(SUM(actual_revenue),0)::numeric(12,2) AS revenue,
           COALESCE(SUM(dine_orders),0)::int AS dine_orders
         FROM daily_reports
         WHERE store ILIKE $1 AND date BETWEEN $2::date AND $3::date`,
        [`%${store}%`, start, end]
      );
      const revFallback = Number(r.rows?.[0]?.revenue || 0);
      const dineOrders = Number(r.rows?.[0]?.dine_orders || 0);
      if (!revenue && revFallback) revenue = revFallback;
      dineQty = dineOrders;
      if (dineOrders > 0 && revenue > 0) avgTicket = revenue / dineOrders;
    } catch (_) {}
  }

  // 桌访桌数（OP_011）用于近似翻台率
  let tableVisitTables = null;
  try {
    const m = await executeMetrics(['OP_011'], timeRange, store);
    tableVisitTables = Number(m.OP_011?.value || 0);
  } catch (_) {}

  if (dineQty != null && tableVisitTables > 0 && dineQty > 0) {
    tableTurnover = dineQty / tableVisitTables;
  }

  return {
    revenue,
    cost,
    avgTicket,
    tableTurnover
  };
}

function buildFallbackActions(anomalies) {
  const issues = Array.isArray(anomalies) ? anomalies : [];
  const actions = [];
  if (issues.includes('利润率偏低')) {
    actions.push('出品经理复盘菜品毛利结构：剔除毛利<某阈值的低效SKU，并把替代品替换到当日热销位（今天午高峰前完成）');
  }
  if (issues.includes('客单价偏低')) {
    actions.push('店长下发加购话术与套餐组合：针对桌访/点单Top菜做“主菜+小吃”搭配，明确赠品/加购价（今天下午收档前完成）');
  }
  if (issues.includes('翻台率不足')) {
    actions.push('前厅经理优化迎宾与出餐节奏：把高峰时段桌面周转目标拆到服务员到位时间，并用20分钟复盘一次（明日午高峰前完成）');
  }
  // 保底：至少 2 条具体动作（即使 anomalies 为空也要满足验收）
  if (actions.length < 2) {
    actions.push('店长做数据对照：把昨日“营收、客单、翻台率”与前日逐项列出差异，并锁定第一优先级（今天收档前完成）');
  }
  if (actions.length < 2) {
    actions.push('安排当日执行动作清单：指定责任人、完成时间点、复盘口径，并在微信群同步（今天午高峰后完成）');
  }
  return actions.slice(0, 3);
}

function resolvePlannerLlmContext(plan, llmContextOverride) {
  if (llmContextOverride && typeof llmContextOverride === 'object') {
    return {
      intent: llmContextOverride.intent ?? 'query',
      complexity: llmContextOverride.complexity ?? 'low',
      mode: llmContextOverride.mode ?? 'single'
    };
  }
  return {
    intent: plan.intent ?? 'query',
    complexity: plan.complexity ?? 'low',
    mode: plan.mode ?? 'single'
  };
}

export async function planAndExecute(text, ctx, llmContextOverride) {
  const t = String(text || '');
  // 补齐 store：避免 ctx.store 为空导致 Planner 直接退化为 no_store
  if (ctx && !ctx.store && ctx.username) {
    try {
      const r = await query(
        `SELECT store
         FROM feishu_users
         WHERE lower(username) = lower($1) AND registered = TRUE
         LIMIT 1`,
        [ctx.username]
      );
      if (r.rows?.[0]?.store) ctx.store = r.rows[0].store;
    } catch (_) { /* ignore */ }
  }
  if (ctx && !ctx.store) {
    if (/马己仙/.test(t)) ctx.store = '马己仙';
    else if (/洪潮/.test(t)) ctx.store = '洪潮';
  }

  const plan = buildPlan(text, ctx);
  const llmCtx = resolvePlannerLlmContext(plan, llmContextOverride);
  if (plan.mode !== 'workflow') return { mode: 'single', plan };

  // 操作请求：发起审批闭环（schedule_change / inventory_update）
  if (isOperationRequest(text)) {
    const store = ctx.store;
    const approvalTaskType = 'schedule_change';
    const riskDescription = '排班调整可能影响员工在岗合规、岗位覆盖与劳动时长，请审批后方可执行。';

    const fallbackActs = [
      '前台/出品经理整理今日与明日待调整班次（含岗位、人数、覆盖时段），并形成变更清单',
      '店长发起审批：提交变更清单+风险说明，等待审批通过后再下发排班'
    ];

    let suggestionsText = '';
    try {
      const prompt = `
你是餐饮运营助理。用户提出排班调整请求，需要你输出可审批的“建议文本”，供审批人快速判断。
用户请求：${String(text || '').trim()}
门店：${store}

要求输出（必须包含下列分区）：
【经营总结】
【问题分析】
【行动建议】
1.（必须具体动作）
2.（必须具体动作）

动作必须落到“谁做什么、何时完成”，禁止空话。
`.trim();

      const r = await callLLM(
        [
          {
            role: 'system',
            content: `你不是问答助手，你是餐饮企业中的“岗位负责人”（排班审批运营助理岗位）。
你必须输出“可审批的建议文本”，用于后续审批闭环；文本部分严格包含【经营总结】【问题分析】【行动建议】并且每条动作必须编号为 1. 2.。
` + DUAL_OUTPUT_SYSTEM_PROMPT_TAIL
          },
          { role: 'user', content: prompt }
        ],
        { temperature: 0.3, max_tokens: 600, purpose: 'planner_schedule_approval', context: llmCtx }
      );
      suggestionsText = stripJsonFromLLMResponse(String(r.content || '').trim());
    } catch (e) {
      logger.warn({ err: e?.message }, 'planner operation llm failed, fallback');
    }

    if (!suggestionsText) {
      suggestionsText = `【经营总结】排班调整已整理为可审批的变更清单。\n【问题分析】主要风险是岗位覆盖与合规时长。\n【行动建议】\n1. ${fallbackActs[0]}\n2. ${fallbackActs[1]}`;
    }

    const approvalTitle = '排班调整（待审批）';
    const taskId = `AP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await createTask({
        taskId,
        source: 'master_planner',
        category: approvalTaskType,
        severity: 'high',
        store,
        brand: '',
        title: approvalTitle,
        detail: suggestionsText.slice(0, 2000),
        sourceData: {
          task_type: approvalTaskType,
          ai_suggestion: suggestionsText.slice(0, 1200),
          risk_description: riskDescription
        },
        assigneeUsername: '',
        assigneeRole: 'store_manager'
      });
      await transitionTask(taskId, 'awaiting_approval', 'planner', {
        responseText: suggestionsText.slice(0, 1200)
      });
      const approvalHint = `\n\n（系统提示：该变更需要审批，任务ID：#${taskId.slice(0, 8)}）`;
      return {
        agent: 'master_planner',
        response: suggestionsText + approvalHint,
        data: { approvalTaskType, riskDescription, plan },
        plan,
        store
      };
    } catch (e) {
      // DB 只读或表结构未准备好时，不阻断用户查看建议
      const approvalHint = `\n\n（系统提示：当前无法写入审批单，建议仍已生成供你人工审批/执行。）`;
      return {
        agent: 'master_planner',
        response: suggestionsText + approvalHint,
        data: { approvalTaskType, riskDescription, createApprovalFailed: true, error: e?.message, plan },
        plan,
        store
      };
    }
  }

  // fetch_data
  const timeRange = extractTimeRangeFromText(text);
  const store = ctx.store;
  const fetched = await fetchDailyBusinessData(store, timeRange);

  // analyze_business
  const analysis = analyzeDailyBusiness({
    revenue: fetched.revenue,
    cost: fetched.cost,
    avgTicket: fetched.avgTicket,
    tableTurnover: fetched.tableTurnover
  });

  const tone = plan.tasks.find(t => t.type === 'generate_suggestion')?.input?.tone || '务实、可执行';

  // generate_suggestion
  const fallbackActions = buildFallbackActions(analysis.anomalies);
  let suggestionsText = '';
  try {
    const prompt = buildBusinessPrompt(
      {
        revenue: analysis.revenue,
        profitRate: analysis.profitRate,
        avgTicket: analysis.avgTicket,
        tableTurnover: analysis.tableTurnover,
        anomalies: analysis.anomalies
      },
      tone
    );
    const r = await callLLM(
      [
        {
          role: 'system',
          content: `你不是问答助手，你是餐饮企业中的“岗位负责人”（区域经理岗位）。
你必须把经营分析转写为“经营总结 + 问题分析 + 行动建议”的执行驱动建议；文本部分严格遵守用户 prompt 给定的分区标题与动作编号格式（【经营总结】【问题分析】【行动建议】 + 1. 2. 编号动作）。
` + DUAL_OUTPUT_SYSTEM_PROMPT_TAIL
        },
        { role: 'user', content: prompt }
      ],
      { temperature: 0.3, max_tokens: 700, purpose: 'planner_business_suggestions', context: llmCtx }
    );
    suggestionsText = stripJsonFromLLMResponse(String(r.content || '').trim());
  } catch (e) {
    logger.warn({ err: e?.message }, 'planner: llm suggestion failed, fallback');
  }

  if (!suggestionsText) {
    const acts = fallbackActions.slice(0, 2).map((a, i) => `${i + 1}. ${a}`);
    suggestionsText = `【经营总结】昨日经营数据已就绪，核心问题围绕利润率/客单/翻台率。\n【问题分析】${analysis.anomalies.length ? analysis.anomalies.join('、') : '暂无明显异常'}。\n【行动建议】\n${acts.join('\n')}`;
  }

  suggestionsText = ensureMinActionsText(suggestionsText, fallbackActions);

  // 组织最终返回结构（message-pipeline 会直接作为 response 文本发送）
  const summary = `营收：¥${Number(analysis.revenue || 0).toFixed(0)}，毛利率：${analysis.profitRate != null ? (analysis.profitRate * 100).toFixed(1) + '%' : '暂无'}，客单价：${analysis.avgTicket != null ? analysis.avgTicket.toFixed(0) : '暂无'}，翻台率：${analysis.tableTurnover != null ? analysis.tableTurnover.toFixed(2) : '暂无'}`;

  return {
    agent: 'master_planner',
    response: `【营业数据】${summary}\n\n${suggestionsText}`,
    data: {
      fetched,
      analysis,
      summary,
      timeRange,
      plan
    },
    plan,
    store
  };
}

export function planMessage(text, ctx) {
  return buildPlan(text, ctx);
}

