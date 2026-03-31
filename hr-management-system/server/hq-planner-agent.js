// ─────────────────────────────────────────────────────────────────
// HQ Planner Agent — 总部决策大脑: 策略生成 + 合规审查 + 行动计划
// ─────────────────────────────────────────────────────────────────
//
// 架构设计:
//   1. Planner (策略生成者): 基于图谱数据生成行动方案
//   2. Compliance Guard (合规审查者): 校验方案数据引用真实性 + 操作边界合法性
//   3. Plan Manager: 管理计划生命周期 (draft → pending_review → approved → executing → completed)
//
// 算力控制:
//   - 仅 admin/hq_manager/hr_manager 角色可触发
//   - 使用 HQ Brain tier 模型（高深度推理）
//   - 日调用频次受限 (≤60次/小时)
//
// 安全机制:
//   - 生成的计划不直接写库执行，必须经审批流
//   - 所有数据引用必须追溯到真实 DB 查询结果
//   - Compliance Guard 温度为0，零容忍审查
// ─────────────────────────────────────────────────────────────────

import { pool as getUnifiedPool } from './utils/database.js';
import {
  traceCausalChain,
  getStoreHealthOverview,
  crossStoreComparison,
  formatGraphContextForLLM
} from './knowledge-graph.js';
import {
  getModelForRole,
  getTemperatureForRole,
  getMaxTokensForRole,
  trackLLMCall,
  isHqRole
} from './hq-brain-config.js';

let _pool = null;
let _callLLM = null;

export function setHqPlannerPool(p) { _pool = p; }
export function setHqPlannerLLM(fn) { _callLLM = fn; }

function pool() {
  if (_pool) return _pool;
  return getUnifiedPool();
}

function extractFirstJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function normalizeTextArray(input, maxCount = 6) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of arr) {
    const v = String(item || '').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    if (out.includes(v)) continue;
    out.push(v.slice(0, 120));
    if (out.length >= maxCount) break;
  }
  return out;
}

function buildRuleBasedActions(storeHealth = {}) {
  const bd = storeHealth.scoreBreakdown || {};
  const scored = [
    { key: 'anomalyDeduct', label: '异常任务闭环', role: 'store_manager', deadline: '3天', kpi: '近7天异常任务响应时效<2小时，逾期任务清零', verify: '复核master_tasks响应时长与状态流转' },
    { key: 'materialDeduct', label: '原料异常处置', role: 'store_production_manager', deadline: '7天', kpi: '原料异常重复发生率下降30%', verify: '复核原料日报异常字段与整改记录' },
    { key: 'closingDeduct', label: '收档标准执行', role: 'store_production_manager', deadline: '7天', kpi: '收档合格率≥95%，平均分提升至90+', verify: '复核收档表通过率与均分' },
    { key: 'complaintDeduct', label: '桌访投诉治理', role: 'store_manager', deadline: '7天', kpi: '投诉率较近30天下降20%', verify: '复核桌访投诉率趋势' }
  ].sort((a, b) => Number(bd[b.key] || 0) - Number(bd[a.key] || 0));
  const actions = [];
  for (const item of scored) {
    if (Number(bd[item.key] || 0) <= 0) continue;
    actions.push({
      priority: actions.length + 1,
      action: `针对${item.label}制定周执行清单并每日复盘，明确责任人与完成时限。`,
      responsibleRole: item.role,
      deadline: item.deadline,
      kpiTarget: item.kpi,
      verificationMethod: item.verify
    });
    if (actions.length >= 4) break;
  }
  if (!actions.length) {
    actions.push({
      priority: 1,
      action: '建立门店周度经营复盘机制，固定追踪异常、投诉与巡检通过率。',
      responsibleRole: 'store_manager',
      deadline: '7天',
      kpiTarget: '健康分较当前提升5分以上',
      verificationMethod: '复核下周期健康分与扣分结构'
    });
  }
  return actions;
}

function normalizePlanData(planData, { store, goal, storeHealth, rawContent }) {
  const src = planData && typeof planData === 'object' ? planData : {};
  const title = String(src.title || `${store} 改善行动计划`).trim() || `${store} 改善行动计划`;
  const summaryBase = String(src.summary || '').replace(/\s+/g, ' ').trim();
  const summary = (summaryBase || `围绕“${goal || '综合提升门店运营表现'}”聚焦主要扣分项进行分阶段改善。`).slice(0, 120);

  const rootCauses = normalizeTextArray(src.rootCauses, 5);
  const rawActions = Array.isArray(src.actions) ? src.actions : [];
  const actions = rawActions
    .map((a, idx) => ({
      priority: Math.max(1, Math.min(10, Number(a?.priority) || idx + 1)),
      action: String(a?.action || '').replace(/\s+/g, ' ').trim(),
      responsibleRole: /store_production_manager|出品/.test(String(a?.responsibleRole || '')) ? 'store_production_manager' : 'store_manager',
      deadline: String(a?.deadline || '').replace(/\s+/g, ' ').trim() || '7天',
      kpiTarget: String(a?.kpiTarget || '').replace(/\s+/g, ' ').trim() || '关键指标连续7天改善',
      verificationMethod: String(a?.verificationMethod || '').replace(/\s+/g, ' ').trim() || '由总部按周复核关键数据'
    }))
    .filter((a) => !!a.action)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 6);

  const safeActions = actions.length ? actions : buildRuleBasedActions(storeHealth);
  const expectedOutcome = String(src.expectedOutcome || '').replace(/\s+/g, ' ').trim() || '预计2-4周内健康分回升，异常闭环与投诉率明显改善。';
  const dataGaps = normalizeTextArray(src.dataGaps, 4);

  const normalized = {
    title,
    summary,
    rootCauses,
    actions: safeActions,
    expectedOutcome,
    dataGaps
  };
  if (rawContent && !src.actions?.length) normalized.rawContent = String(rawContent || '').slice(0, 800);
  return normalized;
}

async function repairPlanJson(rawContent, role) {
  const parsed = extractFirstJsonObject(rawContent);
  if (parsed) return parsed;
  const repaired = await callLLMTiered([
    {
      role: 'system',
      content: '你是JSON修复器。把输入内容转换成合法JSON对象。仅返回JSON，不要任何解释。JSON键必须是:title,summary,rootCauses,actions,expectedOutcome,dataGaps。'
    },
    { role: 'user', content: String(rawContent || '') }
  ], role, { purpose: 'analysis', temperature: 0, maxTokens: 1800, skipCache: true });
  if (!repaired?.ok) return null;
  return extractFirstJsonObject(repaired.content || '');
}

function formatPlanReply(result, targetStore) {
  const planData = result.plan || {};
  const lines = [];
  lines.push(`📋 行动计划 [${result.planId}]`);
  lines.push(`门店：${targetStore} ｜ 健康分：${result.healthScore}/100`);
  lines.push('');
  lines.push(`📌 计划主题：${planData.title || '改善计划'}`);
  lines.push(`摘要：${planData.summary || '-'}`);
  if (Array.isArray(planData.rootCauses) && planData.rootCauses.length) {
    lines.push('');
    lines.push('🔍 核心根因');
    planData.rootCauses.slice(0, 5).forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }
  if (Array.isArray(planData.actions) && planData.actions.length) {
    lines.push('');
    lines.push('📝 行动清单');
    planData.actions.slice(0, 6).forEach((a, i) => {
      lines.push(`${i + 1}) ${a.action}`);
      lines.push(`   负责人: ${a.responsibleRole || '-'} ｜ 时限: ${a.deadline || '-'} ｜ KPI: ${a.kpiTarget || '-'}`);
      lines.push(`   验收: ${a.verificationMethod || '-'}`);
    });
  }
  if (planData.expectedOutcome) {
    lines.push('');
    lines.push(`🎯 预期结果：${planData.expectedOutcome}`);
  }
  if (Array.isArray(planData.dataGaps) && planData.dataGaps.length) {
    lines.push(`💡 数据补充：${planData.dataGaps.join('；')}`);
  }
  if (result.compliance?.passed === false) {
    const issues = [];
    const checks = result.compliance?.checks || {};
    for (const [, v] of Object.entries(checks)) {
      if (!v?.passed && Array.isArray(v?.issues)) issues.push(...v.issues);
    }
    if (issues.length) lines.push(`⚠️ 合规提示：${issues.join('；')}`);
  }
  if (result.status === 'pending_review') {
    lines.push('');
    lines.push(`回复“审批通过 ${result.planId}”可下发执行。`);
  }
  return lines.filter(Boolean).join('\n');
}

async function callLLMTiered(messages, role, options = {}) {
  if (!_callLLM) throw new Error('HQ Planner: callLLM not set');
  const model = getModelForRole(role, options.purpose || 'reasoning');
  const temperature = options.temperature ?? getTemperatureForRole(role);
  const maxTokens = options.maxTokens ?? getMaxTokensForRole(role);
  const result = await _callLLM(messages, {
    model,
    temperature,
    max_tokens: maxTokens,
    skipCache: true,
    ...options
  });
  // 算力追踪
  const tier = isHqRole(role) ? 'hq_brain' : 'store_limb';
  trackLLMCall(tier, result?.raw?.usage?.total_tokens || 0);
  return result;
}

// ─────────────────────────────────────────────
// 1. Strategy Planner (策略生成)
// ─────────────────────────────────────────────

export async function generateActionPlan({ store, goal, role, createdBy, daysBack = 30 }) {
  if (!isHqRole(role)) {
    return { ok: false, error: 'forbidden', message: '仅总部角色可生成行动计划' };
  }

  const planId = `AP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const windowDays = Math.max(7, Math.min(90, Number(daysBack) || 30));

  try {
    // Step 1: 收集图谱上下文
    const [storeHealth, causalChain] = await Promise.all([
      getStoreHealthOverview(store, windowDays),
      traceCausalChain('store', store, 2, windowDays)
    ]);

    const graphContext = formatGraphContextForLLM(causalChain, 40);

    // Step 2: 收集最近异常任务
    const recentTasks = await pool().query(
      `SELECT task_id, category, severity, title, status, score_impact, created_at
       FROM master_tasks WHERE store = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY created_at DESC LIMIT 20`,
      [store, windowDays]
    );

    const tasksSummary = (recentTasks.rows || []).map(t =>
      `[${t.task_id}] ${t.category}(${t.severity}) - ${t.title} - 状态:${t.status} 扣分:${t.score_impact || 0}`
    ).join('\n');

    // Step 3: 收集最近绩效数据
    const recentScores = await pool().query(
      `SELECT username, role, total_score, period, summary
       FROM agent_scores WHERE store = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY created_at DESC LIMIT 10`,
      [store, Math.max(windowDays, 60)]
    );

    const scoresSummary = (recentScores.rows || []).map(s =>
      `${s.username}(${s.role}) ${s.period}: ${s.total_score}分 - ${String(s.summary || '').slice(0, 80)}`
    ).join('\n');

    // Step 4: LLM 生成策略 (使用 HQ Brain 高级模型)
    const healthBreakdown = storeHealth.scoreBreakdown || {};
    const plannerPrompt = `你是年年有喜餐饮集团的总部策略规划AI。你的任务是基于真实数据为门店生成可执行的改善行动计划。

## 绝对禁止
1. 不得编造任何数字或事实——所有引用的数据必须来自下方"数据上下文"
2. 不得凭空提及菜品名（如"卤鹅"等），除非数据上下文中明确出现
3. 如果某方面数据为空或为0，直接说明"该维度暂无数据"，不得猜测

## 目标门店
${store}

## 改善目标
${goal || '综合提升门店运营表现'}

## 数据上下文 (近${windowDays}天)

### 健康分: ${storeHealth.healthScore}/100
扣分明细: 异常任务扣${healthBreakdown.anomalyDeduct || 0}分, 原料扣${healthBreakdown.materialDeduct || 0}分, 收档不合格扣${healthBreakdown.closingDeduct || 0}分, 桌访投诉扣${healthBreakdown.complaintDeduct || 0}分

### 异常任务(来自系统派发)
${storeHealth.anomalies?.length ? storeHealth.anomalies.map(a => `· ${a.category} ${a.severity}级 ${a.count}次`).join('\n') : '(无异常任务记录)'}

### 原料问题
${storeHealth.materialIssues?.length ? storeHealth.materialIssues.map(m => `· ${m.material} ${m.severity || ''} ${m.count}次`).join('\n') : '(无原料异常)'}

### 收档检查
总${storeHealth.inspections?.closingTotal || 0}次, 通过${storeHealth.inspections?.closingPassed || 0}次, 通过率${storeHealth.inspections?.closingPassRate || 'N/A'}, 平均分${storeHealth.inspections?.closingAvgScore || 'N/A'}

### 桌访反馈
总桌访${storeHealth.complaints?.tableVisitTotal || 0}次, 有投诉${storeHealth.complaints?.withComplaints || 0}次, 投诉率${storeHealth.complaints?.complaintRate || 'N/A'}

### 销售概况
有数据${storeHealth.sales?.daysWithData || 0}天, 日均营收￥${storeHealth.sales?.avgDailyRevenue || 0}

### 近期异常任务明细
${tasksSummary || '(无近期异常)'}

### 绩效数据
${scoresSummary || '(无绩效数据)'}

## 输出要求
请以JSON格式返回行动计划:
{
  "title": "计划标题",
  "summary": "100字以内的计划摘要，概述主要问题和改善方向",
  "rootCauses": ["根因1（必须有数据支撑）", "根因2"],
  "actions": [
    {
      "priority": 1,
      "action": "具体行动描述",
      "responsibleRole": "store_manager 或 store_production_manager",
      "deadline": "相对天数，如7天",
      "kpiTarget": "可量化的目标",
      "verificationMethod": "验收方式"
    }
  ],
  "expectedOutcome": "预期改善效果",
  "dataGaps": ["数据不足的方面（如有）"]
}`;

    const planResult = await callLLMTiered([
      { role: 'system', content: plannerPrompt },
      { role: 'user', content: `请为 ${store} 生成改善行动计划。目标: ${goal || '综合提升'}` }
    ], role, { purpose: 'reasoning', maxTokens: 4096 });

    if (!planResult.ok) {
      return { ok: false, error: 'llm_failed', message: planResult.error };
    }

    // 解析/修复并归一化 LLM 输出，确保产出结构稳定可用
    const repaired = await repairPlanJson(planResult.content, role);
    const planData = normalizePlanData(repaired || {}, {
      store,
      goal,
      storeHealth,
      rawContent: planResult.content
    });

    // Step 5: 合规审查
    const complianceResult = await runComplianceCheck(planData, {
      store, storeHealth, graphContext, tasksSummary, scoresSummary, role
    });

    // Step 6: 存入 action_plans
    const status = complianceResult.passed ? 'pending_review' : 'compliance_rejected';
    await pool().query(
      `INSERT INTO action_plans (plan_id, title, goal, store, brand, status, plan_data, compliance_result, graph_context, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
      [
        planId,
        planData.title || `${store} 改善计划`,
        goal || '综合提升',
        store,
        inferBrand(store),
        status,
        JSON.stringify(planData),
        JSON.stringify(complianceResult),
        JSON.stringify({ healthScore: storeHealth.healthScore, causalChainLength: causalChain.length }),
        createdBy || 'system'
      ]
    );

    console.log(`[hq-planner] Plan ${planId} created for ${store}, status: ${status}`);
    return {
      ok: true,
      planId,
      status,
      plan: planData,
      compliance: complianceResult,
      healthScore: storeHealth.healthScore
    };
  } catch (e) {
    console.error('[hq-planner] generateActionPlan error:', e?.message);
    return { ok: false, error: 'internal', message: e?.message };
  }
}

// ─────────────────────────────────────────────
// 2. Compliance Guard (合规审查)
// ─────────────────────────────────────────────

async function runComplianceCheck(planData, context) {
  try {
    const { store, storeHealth, graphContext, tasksSummary, scoresSummary, role } = context;

    const compliancePrompt = `你是年年有喜餐饮集团的合规审查AI。你的唯一职责是校验行动计划的合规性。

## 审查标准 (必须全部通过)

### 1. 数据真实性校验
- 计划中引用的所有数字（健康分、异常次数、绩效分）是否与提供的"真实数据"一致
- 是否存在凭空编造的统计数据或趋势

### 2. 操作边界校验
- 计划中的行动是否在系统当前能力范围内（飞书通知、任务派发、绩效扣分、培训下发）
- 是否包含系统无法执行的操作（如：直接修改供应商合同、调整菜品价格等外部操作）

### 3. 权限校验
- 计划指定的责任人角色是否合理（store_manager 或 store_production_manager）
- 是否越权操作（如门店角色审批总部决策）

## 真实数据参照
门店: ${store}
健康分: ${storeHealth?.healthScore}
异常: ${JSON.stringify(storeHealth?.anomalies || [])}
投诉: ${JSON.stringify(storeHealth?.complaints || [])}
图谱: ${graphContext?.slice(0, 500) || '无'}
任务: ${tasksSummary?.slice(0, 500) || '无'}
绩效: ${scoresSummary?.slice(0, 300) || '无'}

## 待审查的行动计划
${JSON.stringify(planData, null, 2)}

## 输出格式
{
  "passed": true/false,
  "checks": {
    "dataAccuracy": {"passed": true/false, "issues": ["问题描述"]},
    "operationBoundary": {"passed": true/false, "issues": ["问题描述"]},
    "permissionCheck": {"passed": true/false, "issues": ["问题描述"]}
  },
  "overallComment": "总体评语"
}`;

    const complianceResult = await callLLMTiered([
      { role: 'system', content: compliancePrompt },
      { role: 'user', content: '请审查上述行动计划的合规性。' }
    ], role, { purpose: 'analysis', temperature: 0, maxTokens: 2048 });

    if (!complianceResult.ok) {
      return { passed: false, error: 'compliance_llm_failed', checks: {}, overallComment: complianceResult.error };
    }

    try {
      const cleaned = complianceResult.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (e) {
      // 保守策略: 解析失败则不通过
      return {
        passed: false,
        checks: {},
        overallComment: `合规审查解析失败: ${complianceResult.content?.slice(0, 200)}`,
        rawResponse: complianceResult.content
      };
    }
  } catch (e) {
    console.error('[hq-planner] compliance check error:', e?.message);
    return { passed: false, error: 'compliance_error', checks: {}, overallComment: e?.message };
  }
}

// ─────────────────────────────────────────────
// 3. Plan Lifecycle Management
// ─────────────────────────────────────────────

// 审批通过 → 拆解为 OP 任务
export async function approvePlan(planId, approvedBy) {
  try {
    const r = await pool().query(`SELECT * FROM action_plans WHERE plan_id = $1`, [planId]);
    const plan = r.rows?.[0];
    if (!plan) return { ok: false, error: 'not_found' };
    if (plan.status !== 'pending_review') return { ok: false, error: `invalid_status: ${plan.status}` };

    await pool().query(
      `UPDATE action_plans SET status = 'approved', approved_by = $1, updated_at = NOW() WHERE plan_id = $2`,
      [approvedBy, planId]
    );

    // 将行动计划拆解为 master_tasks
    const planData = plan.plan_data || {};
    const actions = Array.isArray(planData.actions) ? planData.actions : [];
    let createdTasks = 0;

    for (const action of actions) {
      try {
        const taskId = `AP-TASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
        await pool().query(
          `INSERT INTO master_tasks (task_id, status, source, source_ref, current_agent, category, severity, store, brand, title, detail, source_data)
           VALUES ($1, 'pending_dispatch', 'action_plan', $2, 'master', $3, 'medium', $4, $5, $6, $7, $8::jsonb)`,
          [
            taskId, planId,
            '行动计划任务',
            plan.store, plan.brand || '',
            action.action || '待执行任务',
            `来源计划: ${planId}\nKPI目标: ${action.kpiTarget || '无'}\n验收标准: ${action.verificationMethod || '无'}\n截止: ${action.deadline || '无'}`,
            JSON.stringify({ planId, priority: action.priority, responsibleRole: action.responsibleRole })
          ]
        );
        createdTasks++;
      } catch (e) {
        console.error(`[hq-planner] Failed to create task from plan action:`, e?.message);
      }
    }

    await pool().query(
      `UPDATE action_plans SET status = 'executing', updated_at = NOW() WHERE plan_id = $1`,
      [planId]
    );

    console.log(`[hq-planner] Plan ${planId} approved, created ${createdTasks} tasks`);
    return { ok: true, planId, createdTasks };
  } catch (e) {
    console.error('[hq-planner] approvePlan error:', e?.message);
    return { ok: false, error: e?.message };
  }
}

// 驳回计划
export async function rejectPlan(planId, rejectedBy, reason) {
  try {
    await pool().query(
      `UPDATE action_plans SET status = 'rejected', updated_at = NOW(),
       compliance_result = compliance_result || $1::jsonb
       WHERE plan_id = $2`,
      [JSON.stringify({ rejectedBy, rejectionReason: reason, rejectedAt: new Date().toISOString() }), planId]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

// 查询计划列表
export async function listPlans(options = {}) {
  const { store, status, limit = 20 } = options;
  const where = ['1=1'];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (store) where.push(`store = ${push(store)}`);
  if (status) where.push(`status = ${push(status)}`);

  const r = await pool().query(
    `SELECT * FROM action_plans WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`,
    params
  );
  return r.rows || [];
}

// ─────────────────────────────────────────────
// 4. HQ Brain 对话入口 (Feishu 消息路由)
// ─────────────────────────────────────────────

// 门店名模糊匹配: 用户输入 "洪潮久光店" → 匹配 DB 中的 "洪潮大宁久光店"
async function fuzzyMatchStoreName(input) {
  if (!input) return input;
  try {
    const r = await pool().query(`SELECT DISTINCT store FROM feishu_users WHERE store IS NOT NULL AND store != '' AND store != '总部'`);
    const stores = (r.rows || []).map(row => row.store);
    // 精确匹配
    const exact = stores.find(s => s === input);
    if (exact) return exact;
    // 包含匹配: DB中的店名包含用户输入 或 用户输入包含DB中的店名
    const contains = stores.find(s => s.includes(input) || input.includes(s));
    if (contains) return contains;
    // 关键字匹配: 去掉品牌前缀后的核心部分
    const core = input.replace(/^(洪潮|马己仙)/, '');
    if (core.length >= 2) {
      const fuzzy = stores.find(s => s.includes(core));
      if (fuzzy) return fuzzy;
    }
    return input; // 兜底返回原始输入
  } catch (e) {
    return input;
  }
}

// 从用户消息中提取门店名 (止于 "店" 字, 排除关键词干扰)
function extractStoreName(text) {
  const m = text.match(/(洪潮[^\s,，。的生为请]+?店|马己仙[^\s,，。的生为请]+?店)/);
  return m ? m[1] : null;
}

export async function handleHqBrainMessage({ text, role, username, store }) {
  if (!isHqRole(role)) {
    return null; // 非 HQ 角色不处理
  }

  const t = String(text || '').trim();

  // 意图识别: 是否请求生成行动计划
  if (t.includes('行动计划') || t.includes('改善方案') || t.includes('策略') || t.includes('整改方案')) {
    // 提取目标门店
    let targetStore = store;
    const extracted = extractStoreName(t);
    if (extracted) targetStore = await fuzzyMatchStoreName(extracted);

    // 提取目标
    const goalMatch = t.match(/目标[：:]\s*(.+?)(?=[，。\n]|$)/);
    const goal = goalMatch ? goalMatch[1] : t;

    if (!targetStore) {
      return { handled: true, response: '请指定目标门店（如：为洪潮大宁久光店生成行动计划）' };
    }

    const daysBackMatch = t.match(/近\s*(\d{1,3})\s*天/);
    const requestedDays = daysBackMatch ? Number(daysBackMatch[1]) : 30;
    const result = await generateActionPlan({
      store: targetStore,
      goal,
      role,
      createdBy: username,
      daysBack: Math.max(7, Math.min(90, requestedDays || 30))
    });
    if (!result.ok) {
      return { handled: true, response: `行动计划生成失败: ${result.message || result.error}` };
    }

    return { handled: true, response: formatPlanReply(result, targetStore) };
  }

  // 意图识别: 门店健康度查询
  if (t.includes('健康度') || t.includes('健康分') || t.includes('门店诊断')) {
    let targetStore = store;
    const extracted = extractStoreName(t);
    if (extracted) targetStore = await fuzzyMatchStoreName(extracted);

    if (!targetStore) {
      return { handled: true, response: '请指定门店名称（如：洪潮大宁久光店健康度）' };
    }

    const overview = await getStoreHealthOverview(targetStore, 30);
    const bd = overview.scoreBreakdown || {};
    let resp = `🏥 ${targetStore} 健康诊断\n`;
    resp += `综合健康分: ${overview.healthScore}/100 | ${overview.period}\n`;
    resp += `扣分: 异常${bd.anomalyDeduct || 0} 原料${bd.materialDeduct || 0} 收档${bd.closingDeduct || 0} 投诉${bd.complaintDeduct || 0}\n`;

    if (overview.anomalies?.length) {
      resp += `\n⚠️ 异常任务:\n${overview.anomalies.map(a => `  · ${a.category}(${a.severity}): ${a.count}次`).join('\n')}\n`;
    }
    if (overview.materialIssues?.length) {
      resp += `\n🥬 原料问题:\n${overview.materialIssues.map(m => `  · ${m.material}${m.severity ? '(' + m.severity + ')' : ''}: ${m.count}次`).join('\n')}\n`;
    }
    const insp = overview.inspections || {};
    if (insp.closingTotal > 0) {
      resp += `\n📋 收档检查: ${insp.closingTotal}次, 通过率${insp.closingPassRate}, 平均分${insp.closingAvgScore}\n`;
    }
    const tv = overview.complaints || {};
    if (tv.tableVisitTotal > 0) {
      resp += `\n📢 桌访: ${tv.tableVisitTotal}次, 投诉${tv.withComplaints}次(${tv.complaintRate})\n`;
    }
    const sales = overview.sales || {};
    if (sales.daysWithData > 0) {
      resp += `\n💰 销售: ${sales.daysWithData}天数据, 日均￥${sales.avgDailyRevenue}\n`;
    }

    return { handled: true, response: resp };
  }

  // 意图识别: 因果链分析
  if (t.includes('因果') || t.includes('原因') || t.includes('为什么') || t.includes('根因')) {
    let targetStore = store;
    const extracted = extractStoreName(t);
    if (extracted) targetStore = await fuzzyMatchStoreName(extracted);

    if (targetStore) {
      const chain = await traceCausalChain('store', targetStore, 3, 30);
      if (!chain.length) {
        return { handled: true, response: `${targetStore} 的因果关系图谱中暂无关联数据。数据将随着日常运营自动积累。` };
      }
      const formatted = formatGraphContextForLLM(chain, 20);
      return { handled: true, response: `🔗 ${targetStore} 因果关系链 (近30天):\n\n${formatted}` };
    }
  }

  // 意图识别: 审批计划
  const approveMatch = t.match(/审批通过\s*(AP-[a-z0-9-]+)/i);
  if (approveMatch) {
    const result = await approvePlan(approveMatch[1], username);
    if (result.ok) {
      return { handled: true, response: `✅ 计划 ${approveMatch[1]} 已审批通过，已拆解为 ${result.createdTasks} 个执行任务并进入派发流程。` };
    }
    return { handled: true, response: `审批失败: ${result.error}` };
  }

  // 意图识别: 跨门店对比
  if (t.includes('对比') || t.includes('比较')) {
    const rawMatches = t.match(/(洪潮[^\s,，。的生为请]+?店|马己仙[^\s,，。的生为请]+?店)/g);
    const storeMatches = rawMatches ? await Promise.all(rawMatches.map(s => fuzzyMatchStoreName(s))) : null;
    if (storeMatches?.length >= 2) {
      const comparison = await crossStoreComparison(storeMatches, 30);
      let resp = `📊 门店对比分析:\n\n`;
      for (const [s, data] of Object.entries(comparison)) {
        const anomalyCnt = Array.isArray(data?.anomalies) ? data.anomalies.length : 0;
        const complaintCnt = Number(data?.complaints?.withComplaints || 0);
        resp += `【${s}】健康分: ${data.healthScore}/100 | 异常${anomalyCnt}类 | 投诉${complaintCnt}次\n`;
      }
      return { handled: true, response: resp };
    }
  }

  // 未匹配 HQ 专属意图，返回 null 继续走常规流程
  return null;
}

// ─────────────────────────────────────────────
// 5. API Routes
// ─────────────────────────────────────────────

export function registerHqPlannerRoutes(app, authRequired) {

  // 生成行动计划
  app.post('/api/hq/plans', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { store, goal } = req.body || {};
    if (!store) return res.status(400).json({ error: 'missing_store' });
    const result = await generateActionPlan({ store, goal, role, createdBy: req.user?.username });
    return res.json(result);
  });

  // 计划列表
  app.get('/api/hq/plans', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const plans = await listPlans({
      store: req.query?.store,
      status: req.query?.status,
      limit: Number(req.query?.limit) || 20
    });
    return res.json({ items: plans });
  });

  // 计划详情
  app.get('/api/hq/plans/:planId', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool().query(`SELECT * FROM action_plans WHERE plan_id = $1`, [req.params.planId]);
      if (!r.rows?.length) return res.status(404).json({ error: 'not_found' });
      return res.json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e?.message });
    }
  });

  // 审批计划
  app.post('/api/hq/plans/:planId/approve', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const result = await approvePlan(req.params.planId, req.user?.username);
    return res.json(result);
  });

  // 驳回计划
  app.post('/api/hq/plans/:planId/reject', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const result = await rejectPlan(req.params.planId, req.user?.username, req.body?.reason);
    return res.json(result);
  });

  // 门店健康度
  app.get('/api/hq/store-health/:store', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const overview = await getStoreHealthOverview(req.params.store, Number(req.query?.days) || 30);
    return res.json(overview);
  });

  // 因果链查询
  app.get('/api/hq/causal-chain', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { entityType, entityId, maxDepth, daysBack } = req.query || {};
    if (!entityType || !entityId) return res.status(400).json({ error: 'missing entityType/entityId' });
    const chain = await traceCausalChain(entityType, entityId, Number(maxDepth) || 3, Number(daysBack) || 30);
    return res.json({ chain, formatted: formatGraphContextForLLM(chain) });
  });

  // 跨门店对比
  app.post('/api/hq/compare-stores', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { stores, daysBack } = req.body || {};
    if (!Array.isArray(stores) || stores.length < 2) return res.status(400).json({ error: 'need at least 2 stores' });
    const result = await crossStoreComparison(stores, Number(daysBack) || 30);
    return res.json(result);
  });

  // 图谱统计
  app.get('/api/hq/graph-stats', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { getGraphStats } = await import('./knowledge-graph.js');
    const stats = await getGraphStats();
    return res.json(stats);
  });

  // 算力统计
  app.get('/api/hq/cost-stats', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const { getCostStats } = await import('./hq-brain-config.js');
    return res.json(getCostStats(Number(req.query?.days) || 7));
  });
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

function inferBrand(storeName) {
  const s = String(storeName || '').trim();
  if (s.includes('洪潮')) return '洪潮传统潮汕菜';
  if (s.includes('马己仙')) return '马己仙广东小馆';
  return '';
}
